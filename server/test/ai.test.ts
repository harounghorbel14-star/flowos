import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aiActions, aiConversations, aiMessages, aiUsage, tasks } from "../src/db/schema";
import { aiLimiter, fitHistory, runTurn, SYSTEM_PROMPT, type TurnEvent } from "../src/modules/ai/assistant";
import {
  setAiProvider,
  type AiMessage,
  type AiProvider,
  type AiTurnRequest,
} from "../src/modules/ai/provider";
import type { Actor } from "../src/lib/actor";
import { addMember, createOrg, db, type TestUser } from "./helpers";

type Block = Record<string, unknown>;

/** Deterministic stand-in for the model: replays scripted responses and records every request. */
class ScriptedProvider implements AiProvider {
  readonly model = "scripted-test-model";
  requests: AiTurnRequest[] = [];
  constructor(private readonly script: Array<(req: AiTurnRequest) => { content: Block[]; stop: string }>) {}
  async run(request: AiTurnRequest, onText: (d: string) => void): Promise<AiMessage> {
    this.requests.push(structuredClone(request));
    const step = this.script.shift();
    if (!step) throw new Error("script exhausted");
    const { content, stop } = step(request);
    for (const b of content) if (b.type === "text") onText(String(b.text));
    return {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: this.model,
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 0,
      },
    } as unknown as AiMessage;
  }
}

const text = (t: string) => () => ({ content: [{ type: "text", text: t }], stop: "end_turn" });
const callTool =
  (name: string, input: Record<string, unknown>, id = `toolu_${randomUUID()}`) =>
  () => ({
    content: [
      { type: "text", text: "Let me check." },
      { type: "tool_use", id, name, input },
    ],
    stop: "tool_use",
  });
/** The tool_result blocks the assistant sent back in the latest request. */
const lastToolResults = (req: AiTurnRequest) => {
  const last = req.messages.at(-1)!;
  return (last.content as unknown as Block[]).filter((b) => b.type === "tool_result");
};

async function actorFor(user: TestUser, orgId: string): Promise<Actor> {
  const { loadActor } = await import("../src/lib/membership");
  return (await loadActor(db(), user.id, orgId, null)).actor!;
}

async function turn(actor: Actor, conversationId: string, message: string, provider: AiProvider) {
  const events: TurnEvent[] = [];
  await runTurn(db(), actor, conversationId, message, (e) => events.push(e), provider);
  return events;
}

beforeEach(() => aiLimiter.reset());
afterEach(() => setAiProvider(null));

describe("AI assistant", () => {
  it("reports itself as not configured without a provider", async () => {
    const { owner, as } = await createOrg();
    setAiProvider(null);
    expect(await as(owner).ai.status()).toEqual({ configured: false, model: null, includedInPlan: true });
    const c = await as(owner).ai.createConversation({});
    await expect(
      runTurn(db(), await actorFor(owner, (await as(owner).orgs.current()).id), c.id, "hi", () => {}, null),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("answers from permission-scoped tools and stores an append-only transcript with usage", async () => {
    const { owner, org, as } = await createOrg();
    const me = (await as(owner).employees.me())!;
    await as(owner).tasks.create({
      title: "Renew insurance",
      assigneeEmployeeId: me.id,
      dueDate: "2020-01-01",
    });
    await as(owner).tasks.create({ title: "Someone else's work" });
    const c = await as(owner).ai.createConversation({});
    const provider = new ScriptedProvider([
      callTool("list_tasks", { mine: true, overdue: true }),
      (req) => {
        const [result] = lastToolResults(req);
        expect(String(result!.content)).toContain("Renew insurance");
        expect(String(result!.content)).not.toContain("Someone else's work");
        return text("You have one overdue task: Renew insurance.")();
      },
    ]);
    const events = await turn(await actorFor(owner, org.id), c.id, "What is overdue for me?", provider);

    expect(
      events
        .filter((e) => e.type === "text")
        .map((e) => (e as { delta: string }).delta)
        .join(""),
    ).toContain("Renew insurance");
    expect(events).toContainEqual({ type: "tool", name: "list_tasks", outcome: "OK" });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });

    // Stable system prompt (cacheable); per-request context rides in the user message.
    expect(provider.requests[0]!.system).toBe(SYSTEM_PROMPT);
    expect(provider.requests[0]!.system).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // The second request replays the first assistant response unchanged.
    expect(provider.requests[1]!.messages[1]).toEqual({
      role: "assistant",
      content: expect.arrayContaining([expect.objectContaining({ type: "tool_use", name: "list_tasks" })]),
    });

    const convo = await as(owner).ai.conversation({ id: c.id });
    expect(convo.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(convo.title).toBe("What is overdue for me?");
    expect(convo.usage).toMatchObject({
      requests: 2,
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 160,
    });
    await expect(
      db().update(aiMessages).set({ role: "assistant" }).where(eq(aiMessages.conversationId, c.id)),
    ).rejects.toThrow();
  });

  it("only exposes tools the user's role allows, and refuses hidden ones", async () => {
    const { owner, org } = await createOrg();
    const viewer = await addMember(org.id, owner, "VIEWER");
    const { callerFor } = await import("./helpers");
    const c = await callerFor(viewer, org.id).ai.createConversation({});
    const provider = new ScriptedProvider([
      callTool("create_task", { title: "Sneaky" }),
      (req) => {
        expect(lastToolResults(req)[0]).toMatchObject({
          is_error: true,
          content: "This tool is not available to this user.",
        });
        return text("I can't create tasks for you.")();
      },
    ]);
    await turn(await actorFor(viewer, org.id), c.id, "Create a task", provider);
    const names = provider.requests[0]!.tools.map((t) => t.name);
    expect(names).toContain("list_tasks");
    expect(names).not.toContain("create_task");
    expect(names).not.toContain("update_task_status");
    expect(await db().select().from(aiActions).where(eq(aiActions.conversationId, c.id))).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(tasks)
        .where(and(eq(tasks.orgId, org.id), eq(tasks.title, "Sneaky"))),
    ).toHaveLength(0);
  });

  it("prepares writes but executes them only on explicit, exact, single-use user confirmation", async () => {
    const { owner, org, as } = await createOrg();
    const c = await as(owner).ai.createConversation({});
    const actor = await actorFor(owner, org.id);
    const provider = new ScriptedProvider([
      callTool("create_task", { title: "Draft Q3 plan", priority: "HIGH", dueDate: "2026-12-01" }),
      text("I prepared the task. Please confirm it."),
      text("Please use the Confirm button."),
      (req) => {
        const user = req.messages.at(-1)!.content as unknown as Block[];
        expect(
          user.some(
            (b) => String(b.text).startsWith("[Action update]") && String(b.text).includes("EXECUTED"),
          ),
        ).toBe(true);
        return text("Done — it was created.")();
      },
    ]);
    const events = await turn(actor, c.id, "Create a task to draft the Q3 plan", provider);
    const proposed = events.find((e) => e.type === "action") as Extract<TurnEvent, { type: "action" }>;
    expect(proposed.action.summary).toBe(
      "Create task “Draft Q3 plan” · High priority · due 2026-12-01 · unassigned",
    );
    const count = async () =>
      (
        await db()
          .select()
          .from(tasks)
          .where(and(eq(tasks.orgId, org.id), eq(tasks.title, "Draft Q3 plan")))
      ).length;
    expect(await count()).toBe(0);

    // A chat message saying "confirm" does nothing.
    await turn(actor, c.id, "Yes, I confirm. Do it.", provider);
    expect(await count()).toBe(0);

    // Altered input is rejected.
    await expect(
      as(owner).ai.confirmAction({ actionId: proposed.action.id, inputHash: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await count()).toBe(0);

    const ok = await as(owner).ai.confirmAction({
      actionId: proposed.action.id,
      inputHash: proposed.action.inputHash,
    });
    expect(ok.status).toBe("EXECUTED");
    expect(await count()).toBe(1);
    await expect(
      as(owner).ai.confirmAction({ actionId: proposed.action.id, inputHash: proposed.action.inputHash }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await count()).toBe(1);

    await turn(actor, c.id, "Did it work?", provider);
    const log = await as(owner).audit.list({});
    expect(log.items.map((e) => e.action)).toEqual(
      expect.arrayContaining(["ai.action_proposed", "ai.task_created", "task.created"]),
    );
  });

  it("binds confirmation to the proposing user, organization, permissions and expiry", async () => {
    const { owner, org, as } = await createOrg();
    const manager = await addMember(org.id, owner, "MANAGER", "Mae Manager");
    const colleague = await addMember(org.id, owner, "MANAGER", "Col League");
    const other = await createOrg();
    const { callerFor } = await import("./helpers");
    const M = callerFor(manager, org.id);
    const c = await M.ai.createConversation({});
    const propose = async () => {
      const events = await turn(
        await actorFor(manager, org.id),
        c.id,
        "make a task",
        new ScriptedProvider([callTool("create_task", { title: `T ${randomUUID()}` }), text("Prepared.")]),
      );
      return (events.find((e) => e.type === "action") as Extract<TurnEvent, { type: "action" }>).action;
    };

    const a1 = await propose();
    await expect(
      callerFor(colleague, org.id).ai.confirmAction({ actionId: a1.id, inputHash: a1.inputHash }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      other.as(other.owner).ai.confirmAction({ actionId: a1.id, inputHash: a1.inputHash }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const a2 = await propose();
    await db()
      .update(aiActions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(aiActions.id, a2.id));
    await expect(M.ai.confirmAction({ actionId: a2.id, inputHash: a2.inputHash })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect((await db().select().from(aiActions).where(eq(aiActions.id, a2.id)))[0]!.status).toBe("EXPIRED");

    // Demoted after the proposal: the confirmation re-checks current permissions.
    const membership = (await as(owner).orgs.members()).find((m) => m.userId === manager.id)!;
    await as(owner).orgs.changeRole({ membershipId: membership.membershipId, role: "VIEWER" });
    await expect(M.ai.confirmAction({ actionId: a1.id, inputHash: a1.inputHash })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // The user can reject what remains.
    await M.ai.rejectAction({ actionId: a1.id });
    await expect(M.ai.confirmAction({ actionId: a1.id, inputHash: a1.inputHash })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("records a failed execution instead of reporting success", async () => {
    const { owner, org, as } = await createOrg();
    const member = await addMember(org.id, owner, "MEMBER");
    const t = await as(owner).tasks.create({ title: "Owner's task" });
    const { callerFor } = await import("./helpers");
    const c = await callerFor(member, org.id).ai.createConversation({});
    const events = await turn(
      await actorFor(member, org.id),
      c.id,
      "close it",
      new ScriptedProvider([
        callTool("update_task_status", { taskId: t.id, status: "DONE" }),
        text("Prepared."),
      ]),
    );
    const action = (events.find((e) => e.type === "action") as Extract<TurnEvent, { type: "action" }>).action;
    const res = await callerFor(member, org.id).ai.confirmAction({
      actionId: action.id,
      inputHash: action.inputHash,
    });
    expect(res).toMatchObject({
      status: "FAILED",
      error: "You can only change tasks you created or that are assigned to you.",
    });
    expect((await as(owner).tasks.get({ id: t.id })).status).toBe("TODO");
  });

  it("cannot reach another tenant's data through tools", async () => {
    const a = await createOrg();
    const b = await createOrg();
    const secret = await b.as(b.owner).tasks.create({ title: "B confidential roadmap" });
    const c = await a.as(a.owner).ai.createConversation({});
    const provider = new ScriptedProvider([
      callTool("get_task", { taskId: secret.id }),
      (req) => {
        const [r] = lastToolResults(req);
        expect(r).toMatchObject({ is_error: true, content: "Task not found." });
        expect(JSON.stringify(req.messages)).not.toContain("confidential");
        return text("I couldn't find that task.")();
      },
    ]);
    await turn(await actorFor(a.owner, a.org.id), c.id, `Show task ${secret.id}`, provider);
  });

  it("validates tool input, discards refusals and keeps conversations private", async () => {
    const { owner, org, as } = await createOrg();
    const member = await addMember(org.id, owner, "MEMBER");
    const c = await as(owner).ai.createConversation({});
    const actor = await actorFor(owner, org.id);
    const provider = new ScriptedProvider([
      callTool("get_task", { taskId: "not-a-uuid" }),
      (req) => {
        expect(String(lastToolResults(req)[0]!.content)).toMatch(/^Invalid input: taskId/);
        return text("That ID looks wrong.")();
      },
      () => ({ content: [{ type: "text", text: "partial output" }], stop: "refusal" }),
    ]);
    await turn(actor, c.id, "show task not-a-uuid", provider);
    const before = (await db().select().from(aiMessages).where(eq(aiMessages.conversationId, c.id))).length;
    const events = await turn(actor, c.id, "something declined", provider);
    expect(events).toContainEqual({ type: "error", message: "The assistant declined this request." });
    const after = await db().select().from(aiMessages).where(eq(aiMessages.conversationId, c.id));
    expect(after.length).toBe(before + 1); // only the user message; partial refusal output is not stored
    expect(JSON.stringify(after.at(-1)!.content)).not.toContain("partial output");

    const { callerFor } = await import("./helpers");
    await expect(callerFor(member, org.id).ai.conversation({ id: c.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await callerFor(member, org.id).ai.conversations()).toEqual([]);
    const usage = await db().select().from(aiUsage).where(eq(aiUsage.conversationId, c.id));
    expect(usage.map((u) => u.stopReason)).toEqual(["tool_use", "end_turn", "refusal"]);
  });

  it("never runs a truncated tool call and keeps the transcript valid", async () => {
    const { owner, org, as } = await createOrg();
    const c = await as(owner).ai.createConversation({});
    const actor = await actorFor(owner, org.id);
    const id = `toolu_${randomUUID()}`;
    const provider = new ScriptedProvider([
      () => ({
        content: [{ type: "tool_use", id, name: "create_task", input: { title: "Trunc" } }],
        stop: "max_tokens",
      }),
      (req) => {
        // Every tool_use in the replayed history has a matching tool_result.
        const results = (req.messages.at(-2)!.content as unknown as Block[]).filter(
          (b) => b.type === "tool_result",
        );
        expect(results).toEqual([expect.objectContaining({ tool_use_id: id, is_error: true })]);
        return text("Sorry, try again.")();
      },
    ]);
    await turn(actor, c.id, "make a task", provider);
    expect(await db().select().from(aiActions).where(eq(aiActions.conversationId, c.id))).toHaveLength(0);
    await turn(actor, c.id, "again", provider);
  });

  it("rejects concurrent turns in one conversation", async () => {
    const { owner, org, as } = await createOrg();
    const c = await as(owner).ai.createConversation({});
    await db().execute(
      sql`update ai_conversations set locked_until = now() + interval '1 minute' where id = ${c.id}`,
    );
    await expect(
      turn(await actorFor(owner, org.id), c.id, "hi", new ScriptedProvider([text("hi")])),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("confirmation cards name the affected task, person and project", async () => {
    const { owner, org, as } = await createOrg();
    const actor = await actorFor(owner, org.id);
    const t = await as(owner).tasks.create({ title: "Renew office lease" });
    const emp = await as(owner).employees.create({
      firstName: "Lena",
      lastName: "Lopez",
      email: `l-${randomUUID()}@example.test`,
    });
    const project = await as(owner).projects.create({ name: "HQ move" });
    const c = await as(owner).ai.createConversation({});
    const events = await turn(
      actor,
      c.id,
      "Close the lease task and add one for Lena",
      new ScriptedProvider([
        () => ({
          content: [
            {
              type: "tool_use",
              id: `toolu_${randomUUID()}`,
              name: "update_task_status",
              input: { taskId: t.id, status: "DONE" },
            },
            {
              type: "tool_use",
              id: `toolu_${randomUUID()}`,
              name: "create_task",
              input: { title: "Book movers", assigneeEmployeeId: emp.id, projectId: project.id },
            },
          ],
          stop: "tool_use",
        }),
        text("Prepared both."),
      ]),
    );
    const summaries = events.flatMap((e) => (e.type === "action" ? [e.action.summary] : []));
    expect(summaries).toEqual([
      `Move task #${t.number} “Renew office lease” from “To do” to “Done”`,
      "Create task “Book movers” · Medium priority · no due date · assigned to Lena Lopez · in project HQ move",
    ]);
  });

  it("prepares nothing when a write references another organization's record", async () => {
    const a = await createOrg();
    const b = await createOrg();
    const foreignTask = await b.as(b.owner).tasks.create({ title: "Other org task" });
    const foreignEmp = await b.as(b.owner).employees.create({
      firstName: "Far",
      lastName: "Away",
      email: `f-${randomUUID()}@example.test`,
    });
    const actor = await actorFor(a.owner, a.org.id);
    const c = await a.as(a.owner).ai.createConversation({});
    const provider = new ScriptedProvider([
      () => ({
        content: [
          {
            type: "tool_use",
            id: `toolu_${randomUUID()}`,
            name: "update_task_status",
            input: { taskId: foreignTask.id, status: "DONE" },
          },
          {
            type: "tool_use",
            id: `toolu_${randomUUID()}`,
            name: "create_task",
            input: { title: "x", assigneeEmployeeId: foreignEmp.id },
          },
        ],
        stop: "tool_use",
      }),
      text("Could not prepare those."),
    ]);
    const events = await turn(actor, c.id, "Do it", provider);
    expect(events.some((e) => e.type === "action")).toBe(false);
    expect(events.filter((e) => e.type === "tool").map((e) => e.type === "tool" && e.outcome)).toEqual([
      "INVALID",
      "INVALID",
    ]);
    expect(await db().select().from(aiActions).where(eq(aiActions.conversationId, c.id))).toHaveLength(0);
    // The model is told why, without details of the other organization's record.
    const results = JSON.stringify(lastToolResults(provider.requests[1]!));
    expect(results).not.toContain("Other org task");
    expect(results).not.toContain("Far");
  });

  it("a turn whose lock was taken over stops and never releases the newer lock", async () => {
    const { owner, org, as } = await createOrg();
    const actor = await actorFor(owner, org.id);
    const c = await as(owner).ai.createConversation({});
    const stolen = new Date(Date.now() + 120_000);
    const provider = new ScriptedProvider([
      callTool("get_operational_snapshot", {}),
      // Never reached: the lock is lost before the second request.
      text("unreachable"),
    ]);
    const original = provider.run.bind(provider);
    provider.run = async (req, onText) => {
      const res = await original(req, onText);
      // Simulate another tab starting a turn after this one's lock lapsed.
      await db().update(aiConversations).set({ lockedUntil: stolen }).where(eq(aiConversations.id, c.id));
      return res;
    };
    await expect(turn(actor, c.id, "status?", provider)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(provider.requests).toHaveLength(1);
    const [conv] = await db().select().from(aiConversations).where(eq(aiConversations.id, c.id));
    expect(conv!.lockedUntil?.getTime()).toBe(stolen.getTime());
  });

  it("stops the turn when the client disconnects", async () => {
    const { owner, org, as } = await createOrg();
    const actor = await actorFor(owner, org.id);
    const c = await as(owner).ai.createConversation({});
    const abort = new AbortController();
    const provider = new ScriptedProvider([
      () => {
        abort.abort(); // the browser tab closed while the first answer streamed
        return callTool("get_operational_snapshot", {})();
      },
      text("unreachable"),
    ]);
    const events: TurnEvent[] = [];
    await runTurn(db(), actor, c.id, "status?", (e) => events.push(e), provider, abort.signal);
    expect(provider.requests).toHaveLength(1);
    const [conv] = await db().select().from(aiConversations).where(eq(aiConversations.id, c.id));
    expect(conv!.lockedUntil).toBeNull();
  });

  it("drops the oldest whole exchanges when the history outgrows the budget", () => {
    const user = (t: string) => ({ role: "user" as const, content: [{ type: "text" as const, text: t }] });
    const asst = (t: string) => ({
      role: "assistant" as const,
      content: [{ type: "text" as const, text: t }],
    });
    const toolUse = {
      role: "assistant" as const,
      content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
    };
    const toolResult = {
      role: "user" as const,
      content: [{ type: "tool_result", tool_use_id: "t1", content: "r" }],
    };
    const big = "x".repeat(1000);
    const history = [
      user(big),
      asst(big),
      user(big),
      toolUse,
      toolResult,
      asst(big),
      user("latest"),
    ] as never[];
    expect(fitHistory(history, 100_000)).toHaveLength(7);
    const fitted = fitHistory(history, 1500);
    // Cut at an exchange start, never between a tool_use and its tool_result.
    expect(fitted[0]).toEqual(user("latest"));
    const mid = fitHistory(history, 2400);
    expect(mid[0]).toEqual(user(big));
    expect(mid).toHaveLength(5);
  });
});
