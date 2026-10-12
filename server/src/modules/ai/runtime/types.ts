/**
 * Provider-neutral model interface. The engine, tools, transcript and tests
 * depend only on these types; each adapter translates to its provider's wire
 * format. Nothing here assumes a particular vendor.
 */

export type ModelPart =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean }
  /** Provider-specific data that must round-trip (e.g. reasoning blocks); other runtimes drop it. */
  | { type: "opaque"; provider: string; data: unknown };

export interface ModelMessage {
  role: "user" | "assistant";
  content: ModelPart[];
}

export interface ModelTool {
  name: string;
  description: string;
  /** JSON Schema of the input object. Inputs are validated again with Zod before use. */
  inputSchema: Record<string, unknown>;
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "pause";

export interface ModelResponse {
  model: string;
  content: ModelPart[];
  stopReason: StopReason;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  tools: ModelTool[];
}

export interface RuntimeInfo {
  /** Adapter id, e.g. "openai-compatible" or "anthropic". */
  provider: string;
  model: string;
  /** Where inference happens: on infrastructure you run, or a third-party hosted API. */
  hosting: "self-hosted" | "hosted";
  /** Base URL for self-hosted runtimes (shown to admins; never contains credentials). */
  endpoint?: string;
}

export interface ModelRuntime {
  readonly info: RuntimeInfo;
  /** One inference request. Streams text deltas to `onText` when the runtime supports streaming. */
  run(request: ModelRequest, onText: (delta: string) => void, signal?: AbortSignal): Promise<ModelResponse>;
  /** Cheap reachability check (no tokens spent). */
  health(signal?: AbortSignal): Promise<{ ok: boolean; detail?: string }>;
}

/** The runtime could not be reached or timed out: distinct from a tool failure or a bad answer. */
export class ModelUnavailableError extends Error {
  override readonly name = "ModelUnavailableError";
}

/** The runtime answered, but with output that cannot be used (e.g. malformed tool input); safe to re-issue. */
export class ModelOutputError extends Error {
  override readonly name = "ModelOutputError";
}
