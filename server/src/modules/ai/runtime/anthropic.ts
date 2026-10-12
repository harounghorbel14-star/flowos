import Anthropic from "@anthropic-ai/sdk";
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
 * Optional hosted adapter (paid, third-party). Used only when an operator
 * selects it explicitly; the engine never falls back to it.
 */
export const ANTHROPIC_MODEL = "claude-opus-5-5";

type Block = Anthropic.Beta.BetaContentBlockParam;

export function toAnthropicMessages(messages: ModelMessage[]): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.flatMap((p): Block[] => {
      switch (p.type) {
        case "text":
          return [{ type: "text", text: p.text }];
        case "tool_call":
          return [{ type: "tool_use", id: p.id, name: p.name, input: p.input as Record<string, unknown> }];
        case "tool_result":
          return [
            {
              type: "tool_result",
              tool_use_id: p.toolCallId,
              content: p.content,
              ...(p.isError ? { is_error: true } : {}),
            },
          ];
        case "opaque":
          // Reasoning blocks must be replayed unchanged to the provider that produced them.
          return p.provider === "anthropic" ? [p.data as Block] : [];
      }
    }),
  }));
}

const STOP: Record<string, StopReason> = {
  end_turn: "end",
  stop_sequence: "end",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  refusal: "refusal",
  pause_turn: "pause",
};

export class AnthropicRuntime implements ModelRuntime {
  readonly info: RuntimeInfo = { provider: "anthropic", model: ANTHROPIC_MODEL, hosting: "hosted" };
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  // Probing a hosted API would spend a request per status check; configuration is reported instead.
  async health() {
    return { ok: true, detail: "hosted API (not probed)" };
  }

  async run(
    request: ModelRequest,
    onText: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    const stream = this.client.beta.messages.stream(
      {
        model: ANTHROPIC_MODEL,
        max_tokens: 16000,
        output_config: { effort: "medium" },
        cache_control: { type: "ephemeral" },
        system: request.system,
        tools: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Beta.BetaTool["input_schema"],
        })),
        messages: toAnthropicMessages(request.messages),
      },
      { signal },
    );
    stream.on("text", onText);
    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.APIConnectionError) throw new ModelUnavailableError(err.message);
      if (err instanceof Anthropic.APIError) {
        if ((err.status ?? 0) >= 500 || err.status === 429) throw new ModelUnavailableError(err.message);
        throw err;
      }
      // An unparseable tool input surfaces as a plain AnthropicError; re-issuing is safe.
      if (err instanceof Anthropic.AnthropicError) throw new ModelOutputError(err.message);
      throw err;
    }
    const content: ModelPart[] = message.content.map((b): ModelPart => {
      if (b.type === "text") return { type: "text", text: b.text };
      if (b.type === "tool_use") return { type: "tool_call", id: b.id, name: b.name, input: b.input };
      return { type: "opaque", provider: "anthropic", data: b };
    });
    return {
      model: message.model ?? ANTHROPIC_MODEL,
      content,
      stopReason: STOP[message.stop_reason ?? "end_turn"] ?? "end",
      usage: {
        inputTokens: message.usage?.input_tokens ?? 0,
        outputTokens: message.usage?.output_tokens ?? 0,
        cacheReadTokens: message.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage?.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
