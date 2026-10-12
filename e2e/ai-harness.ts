/**
 * TEST HARNESS ONLY — not part of the application build.
 * Starts the real FLOWOS server (production mode, real database) with a
 * scripted model runtime so model mode can be exercised end to end without
 * any inference server. The scripted runtime is a deterministic test double:
 * it plans, calls the real tools and derives its text from their real results.
 *
 *   npm run build:client && npx tsx e2e/ai-harness.ts   (serves on :3200)
 */
import { createApp } from "../server/src/app";
import { getDb } from "../server/src/db/client";
import { setModelRuntime, type ModelPart, type ModelRuntime } from "../server/src/modules/ai/runtime";
import { startWorker } from "../server/src/modules/workflows/engine";

let n = 0;
const reply = (content: ModelPart[], stopReason: "end" | "tool_use") => ({
  model: "scripted-e2e",
  content,
  stopReason,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
});
const call = (name: string, input: Record<string, unknown>): ModelPart => ({
  type: "tool_call",
  id: `call_${++n}`,
  name,
  input,
});

const scripted: ModelRuntime = {
  info: { provider: "scripted", model: "scripted-e2e", hosting: "self-hosted" },
  async health() {
    return { ok: true };
  },
  async run(req, onText, signal) {
    const last = req.messages.at(-1)!;
    const result = last.content.find((p) => p.type === "tool_result");
    const say = (text: string) => {
      for (const word of text.split(/(?<= )/)) onText(word);
      return reply([{ type: "text", text }], "end");
    };
    if (result && result.type === "tool_result") {
      const data = JSON.parse(result.content) as Record<string, unknown>;
      if (Array.isArray(data.accepted)) {
        // The plan was accepted: run its first step.
        const prompt = req.messages.findLast(
          (m) => m.role === "user" && m.content.some((p) => p.type === "text"),
        );
        const asked = prompt?.content.map((p) => (p.type === "text" ? p.text : "")).join(" ") ?? "";
        return asked.toLowerCase().includes("create a task")
          ? reply([call("create_task", { title: "Prepare onboarding pack", priority: "HIGH" })], "tool_use")
          : reply([call("get_operational_snapshot", {})], "tool_use");
      }
      if (data.status === "awaiting_user_confirmation")
        return say(`I prepared this for you: ${String(data.prepared)}. Confirm it below to create it.`);
      const m = data.metrics as Record<string, number>;
      return say(
        `You have ${m.openTasks} open tasks, ${m.overdueTasks} overdue, and ${m.approvalsAwaitingMe} approvals waiting for you.`,
      );
    }
    const text = last.content
      .map((p) => (p.type === "text" ? p.text : ""))
      .join(" ")
      .toLowerCase();
    // A deliberately slow answer, so the browser test can press Stop mid-stream.
    if (text.includes("take your time")) {
      const words = "This answer streams slowly so that it can be stopped. ".repeat(8).split(/(?<= )/);
      for (const word of words) {
        if (signal?.aborted) throw new Error("aborted");
        onText(word);
        await new Promise((r) => setTimeout(r, 120));
      }
      return reply([{ type: "text", text: words.join("") }], "end");
    }
    const creating = text.includes("create a task");
    return reply(
      [
        call("submit_plan", {
          objective: creating ? "Prepare the requested task" : "Summarize what needs attention",
          steps: [
            creating
              ? { tool: "create_task", purpose: "Prepare the task for confirmation" }
              : { tool: "get_operational_snapshot", purpose: "Read live counts" },
          ],
        }),
      ],
      "tool_use",
    );
  },
};

setModelRuntime(scripted);
startWorker(getDb());
createApp().listen(3200, () => console.log("AI test harness on :3200"));
