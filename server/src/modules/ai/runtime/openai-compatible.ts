import {
  ModelOutputError,
  ModelUnavailableError,
  type ModelMessage,
  type ModelPart,
  type ModelRequest,
  type ModelResponse,
  type ModelRuntime,
  type RuntimeInfo,
  type StopReason,
} from "./types";

/**
 * Any server that speaks the OpenAI-compatible Chat Completions API with tool
 * calls: llama.cpp `llama-server --jinja`, Ollama, vLLM, LM Studio, LocalAI.
 * Runs on infrastructure you operate; plain `fetch`, no vendor SDK.
 */
export interface OpenAiCompatibleOptions {
  /** Base URL including the API prefix, e.g. http://localhost:8080/v1 */
  baseUrl: string;
  model: string;
  /** Only for self-hosted gateways that require one; never a third-party SaaS key by default. */
  apiKey?: string;
  timeoutMs?: number;
  maxTokens?: number;
}

type WireMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export function toWireMessages(system: string, messages: ModelMessage[]): WireMessage[] {
  const out: WireMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    const text = m.content
      .filter((p): p is Extract<ModelPart, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n\n");
    if (m.role === "assistant") {
      const calls = m.content.filter(
        (p): p is Extract<ModelPart, { type: "tool_call" }> => p.type === "tool_call",
      );
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      });
      continue;
    }
    // Tool results must directly follow the assistant message that asked for them.
    for (const p of m.content) {
      if (p.type === "tool_result")
        out.push({
          role: "tool",
          tool_call_id: p.toolCallId,
          content: p.isError ? `ERROR: ${p.content}` : p.content,
        });
    }
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

const STOP: Record<string, StopReason> = {
  stop: "end",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_tokens",
  content_filter: "refusal",
};

interface Chunk {
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

export class OpenAiCompatibleRuntime implements ModelRuntime {
  readonly info: RuntimeInfo;
  private readonly base: string;

  constructor(private readonly opts: OpenAiCompatibleOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.info = {
      provider: "openai-compatible",
      model: opts.model,
      hosting: "self-hosted",
      endpoint: this.base,
    };
  }

  private headers() {
    return {
      "content-type": "application/json",
      ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
    };
  }

  async health(signal?: AbortSignal) {
    try {
      const res = await fetch(`${this.base}/models`, {
        headers: this.headers(),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000),
      });
      return res.ok ? { ok: true } : { ok: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.name : "unreachable" };
    }
  }

  async run(
    request: ModelRequest,
    onText: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 120_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(`${this.base}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        signal: combined,
        body: JSON.stringify({
          model: this.opts.model,
          messages: toWireMessages(request.system, request.messages),
          ...(request.tools.length
            ? {
                tools: request.tools.map((t) => ({
                  type: "function",
                  function: { name: t.name, description: t.description, parameters: t.inputSchema },
                })),
                tool_choice: "auto",
              }
            : {}),
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: this.opts.maxTokens ?? 1024,
          temperature: 0.2,
        }),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new ModelUnavailableError(
        timeout.aborted ? "The model runtime timed out." : "The model runtime could not be reached.",
      );
    }
    if (res.status >= 500 || res.status === 404 || res.status === 429) {
      throw new ModelUnavailableError(`The model runtime answered HTTP ${res.status}.`);
    }
    if (!res.ok || !res.body) {
      throw new ModelOutputError(`The model runtime rejected the request (HTTP ${res.status}).`);
    }

    let text = "";
    let model = this.opts.model;
    let finish: string | null = null;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const calls = new Map<number, { id: string; name: string; args: string }>();
    const decoder = new TextDecoder();
    let buffer = "";
    const handle = (line: string) => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      let chunk: Chunk;
      try {
        chunk = JSON.parse(data) as Chunk;
      } catch {
        throw new ModelOutputError("The model runtime sent an unreadable stream.");
      }
      if (chunk.model) model = chunk.model;
      if (chunk.usage) {
        usage.inputTokens = chunk.usage.prompt_tokens ?? usage.inputTokens;
        usage.outputTokens = chunk.usage.completion_tokens ?? usage.outputTokens;
      }
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta;
        if (delta?.content) {
          text += delta.content;
          onText(delta.content);
        }
        for (const tc of delta?.tool_calls ?? []) {
          const entry = calls.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
          calls.set(tc.index, entry);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    };
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          handle(buffer.slice(0, nl).trim());
          buffer = buffer.slice(nl + 1);
        }
      }
      handle(buffer.trim());
    } catch (err) {
      if (err instanceof ModelOutputError || signal?.aborted) throw err;
      throw new ModelUnavailableError(
        timeout.aborted ? "The model runtime timed out." : "The model runtime stream was interrupted.",
      );
    }

    const content: ModelPart[] = [];
    if (text) content.push({ type: "text", text });
    for (const [index, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      let input: unknown = {};
      if (c.args.trim()) {
        try {
          input = JSON.parse(c.args);
        } catch {
          throw new ModelOutputError(`The model produced unparseable input for ${c.name || "a tool"}.`);
        }
      }
      content.push({ type: "tool_call", id: c.id || `call_${index}_${Date.now()}`, name: c.name, input });
    }
    let stopReason = STOP[finish ?? "stop"] ?? "end";
    // Some servers report "stop" even when they emitted tool calls.
    if (calls.size > 0 && stopReason === "end") stopReason = "tool_use";
    return { model, content, stopReason, usage };
  }
}
