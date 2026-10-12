import { randomUUID } from "node:crypto";
import type { Actor } from "../src/lib/actor";
import type { ModelPart, ModelRequest, ModelRuntime, StopReason } from "../src/modules/ai/runtime";
import { db, type TestUser } from "./helpers";

export type Step = (req: ModelRequest) => { content: ModelPart[]; stop: StopReason };

/** Deterministic stand-in for an inference runtime: replays scripted responses and records every request. */
export class ScriptedRuntime implements ModelRuntime {
  readonly info = { provider: "scripted", model: "scripted-test-model", hosting: "self-hosted" as const };
  requests: ModelRequest[] = [];
  constructor(private readonly script: Step[]) {}
  async health() {
    return { ok: true };
  }
  async run(request: ModelRequest, onText: (d: string) => void) {
    this.requests.push(structuredClone(request));
    const step = this.script.shift();
    if (!step) throw new Error("script exhausted");
    const { content, stop } = step(request);
    for (const p of content) if (p.type === "text") onText(p.text);
    return {
      model: this.info.model,
      content,
      stopReason: stop,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 0 },
    };
  }
}

export const text =
  (t: string): Step =>
  () => ({ content: [{ type: "text", text: t }], stop: "end" });
export const callTool =
  (name: string, input: Record<string, unknown>, id = `call_${randomUUID()}`): Step =>
  () => ({
    content: [
      { type: "text", text: "Let me check." },
      { type: "tool_call", id, name, input },
    ],
    stop: "tool_use",
  });
/** The tool results sent back to the model in the latest request. */
export const lastToolResults = (req: ModelRequest) =>
  req.messages
    .at(-1)!
    .content.filter((p): p is Extract<ModelPart, { type: "tool_result" }> => p.type === "tool_result");

export async function actorFor(user: TestUser, orgId: string): Promise<Actor> {
  const { loadActor } = await import("../src/lib/membership");
  return (await loadActor(db(), user.id, orgId, null)).actor!;
}
