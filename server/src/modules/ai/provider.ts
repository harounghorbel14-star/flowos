import Anthropic from "@anthropic-ai/sdk";

export type AiMessageParam = Anthropic.Beta.BetaMessageParam;
export type AiTool = Anthropic.Beta.BetaTool;
export type AiMessage = Anthropic.Beta.BetaMessage;

export interface AiTurnRequest {
  system: string;
  messages: AiMessageParam[];
  tools: AiTool[];
}

/**
 * The only interface the assistant depends on. Implementations run
 * server-side; API keys never reach the browser.
 */
export interface AiProvider {
  readonly model: string;
  /** Run one model request, streaming text deltas to `onText`. */
  run(request: AiTurnRequest, onText: (delta: string) => void, signal?: AbortSignal): Promise<AiMessage>;
}

/** Raised when the provider returned a tool input that could not be parsed; safe to re-issue. */
export class ToolInputParseError extends Error {}

export const ASSISTANT_MODEL = "claude-opus-5-5";

export class AnthropicProvider implements AiProvider {
  readonly model = ASSISTANT_MODEL;
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  async run(
    request: AiTurnRequest,
    onText: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<AiMessage> {
    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: 16000,
        // Adaptive thinking is on by default for this model; effort sets depth.
        output_config: { effort: "medium" },
        // On a safety decline, let the API re-run on its recommended fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        // Stable system prompt + tool list first, so the prefix caches across turns.
        cache_control: { type: "ephemeral" },
        system: request.system,
        tools: request.tools,
        messages: request.messages,
      },
      { signal },
    );
    stream.on("text", onText);
    try {
      return await stream.finalMessage();
    } catch (err) {
      // An unparseable tool input surfaces as a plain AnthropicError (the parent
      // of APIError); that case alone is retryable. API errors propagate.
      if (err instanceof Anthropic.APIError) throw err;
      if (err instanceof Anthropic.AnthropicError) throw new ToolInputParseError(err.message);
      throw err;
    }
  }
}

let provider: AiProvider | null | undefined;

/** The configured provider, or null when no API key is set (assistant reports "not configured"). */
export function getAiProvider(): AiProvider | null {
  if (provider === undefined) {
    const key = process.env.ANTHROPIC_API_KEY;
    provider = key ? new AnthropicProvider(key) : null;
  }
  return provider;
}

/** Test hook: inject a deterministic provider. */
export function setAiProvider(p: AiProvider | null) {
  provider = p;
}
