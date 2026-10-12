import type { ModelMessage, ModelPart } from "./runtime";

/**
 * Stored transcript parts. New messages are written in the neutral ModelPart
 * form; conversations recorded before the engine existed used the Anthropic
 * block form. The transcript is append-only, so both are read here.
 */
type Raw = Record<string, unknown> & { type?: unknown };

export function partsFromStored(content: unknown[]): ModelPart[] {
  const out: ModelPart[] = [];
  for (const item of content) {
    const b = item as Raw;
    switch (b.type) {
      case "text":
        if (typeof b.text === "string") out.push({ type: "text", text: b.text });
        break;
      case "tool_call":
        out.push({ type: "tool_call", id: String(b.id), name: String(b.name), input: b.input ?? {} });
        break;
      case "tool_use": // legacy
        out.push({ type: "tool_call", id: String(b.id), name: String(b.name), input: b.input ?? {} });
        break;
      case "tool_result": {
        const id = typeof b.toolCallId === "string" ? b.toolCallId : String(b.tool_use_id);
        const raw = b.content;
        const text =
          typeof raw === "string"
            ? raw
            : Array.isArray(raw)
              ? raw.map((c) => String((c as Raw).text ?? "")).join("")
              : "";
        out.push({
          type: "tool_result",
          toolCallId: id,
          content: text,
          ...(b.isError === true || b.is_error === true ? { isError: true } : {}),
        });
        break;
      }
      case "opaque":
        out.push({ type: "opaque", provider: String(b.provider), data: b.data });
        break;
      default:
        // Legacy provider-specific blocks (reasoning, server tools) keep round-tripping to their provider.
        out.push({ type: "opaque", provider: "anthropic", data: b });
    }
  }
  return out;
}

export function messagesFromStored(
  rows: Array<{ role: "user" | "assistant"; content: unknown[] }>,
): ModelMessage[] {
  return rows.map((r) => ({ role: r.role, content: partsFromStored(r.content) }));
}

/** Size budget for the history sent per request (~150k tokens at ~4 chars/token). */
export const HISTORY_CHAR_BUDGET = 600_000;

/**
 * Keep a request within the model's context window by dropping the oldest
 * whole exchanges. A cut happens only at the start of an exchange (a user
 * message without tool results), so tool calls and their results stay paired.
 * The current exchange is always kept.
 */
export function fitHistory(messages: ModelMessage[], budget = HISTORY_CHAR_BUDGET): ModelMessage[] {
  const sizes = messages.map((m) => JSON.stringify(m.content).length);
  let total = sizes.reduce((a, b) => a + b, 0);
  if (total <= budget) return messages;
  const isExchangeStart = (m: ModelMessage) =>
    m.role === "user" && !m.content.some((p) => p.type === "tool_result");
  const starts = messages.flatMap((m, i) => (isExchangeStart(m) ? [i] : []));
  let from = 0;
  for (const start of starts) {
    if (start === 0) continue;
    if (total <= budget) break;
    total -= sizes.slice(from, start).reduce((a, b) => a + b, 0);
    from = start;
  }
  return messages.slice(from);
}
