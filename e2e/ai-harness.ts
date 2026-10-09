/**
 * TEST HARNESS ONLY — not part of the application build.
 * Starts the real FLOWOS server (production mode, real database) with a
 * scripted model provider so the assistant UI can be exercised end to end
 * without an API key. The scripted provider is a deterministic test double:
 * it calls the real tools and derives its text from their real results.
 *
 *   npm run build:client && npx tsx e2e/ai-harness.ts   (serves on :3200)
 */
import { randomUUID } from "node:crypto";
import { createApp } from "../server/src/app";
import { getDb } from "../server/src/db/client";
import {
  setAiProvider,
  type AiMessage,
  type AiProvider,
  type AiTurnRequest,
} from "../server/src/modules/ai/provider";
import { startWorker } from "../server/src/modules/workflows/engine";

const reply = (content: unknown[], stop: string) =>
  ({
    id: `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: "scripted-e2e",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }) as unknown as AiMessage;

const scripted: AiProvider = {
  model: "scripted-e2e",
  async run(req: AiTurnRequest, onText) {
    const last = req.messages.at(-1)!;
    const blocks = last.content as unknown as Array<{ type: string; text?: string; content?: string }>;
    const toolResult = blocks.find((b) => b.type === "tool_result");
    const say = (text: string) => {
      for (const word of text.split(/(?<= )/)) onText(word);
      return reply([{ type: "text", text }], "end_turn");
    };
    if (toolResult) {
      const data = JSON.parse(String(toolResult.content)) as Record<string, unknown>;
      if (data.status === "awaiting_user_confirmation")
        return say(`I prepared this for you: ${String(data.prepared)}. Confirm it below to create it.`);
      const m = data.metrics as Record<string, number>;
      return say(
        `You have ${m.openTasks} open tasks, ${m.overdueTasks} overdue, and ${m.approvalsAwaitingMe} approvals waiting for you.`,
      );
    }
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .toLowerCase();
    const id = `toolu_${randomUUID()}`;
    if (text.includes("create a task"))
      return reply(
        [
          {
            type: "tool_use",
            id,
            name: "create_task",
            input: { title: "Prepare onboarding pack", priority: "HIGH" },
          },
        ],
        "tool_use",
      );
    return reply([{ type: "tool_use", id, name: "get_operational_snapshot", input: {} }], "tool_use");
  },
};

setAiProvider(scripted);
startWorker(getDb());
createApp().listen(3200, () => console.log("AI test harness on :3200"));
