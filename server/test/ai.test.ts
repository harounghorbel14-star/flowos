import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aiActions, aiConversations, aiMessages, aiRuns, aiUsage, tasks } from "../src/db/schema";
import { aiLimiter, fitHistory, runTurn, SYSTEM_PROMPT, type TurnEvent } from "../src/modules/ai/assistant";
import { setModelRuntime, type ModelRuntime } from "../src/modules/ai/runtime";
import type { Actor } from "../src/lib/actor";
import { actorFor, callTool, lastToolResults, ScriptedRuntime, text } from "./ai-helpers";
import { addMember, createOrg, db } from "./helpers";

async function turn(actor: Actor, conversationId: string, message: string, runtime: ModelRuntime | null) {
  const events: TurnEvent[] = [];
  await runTurn(db(), actor, conversationId, message, (e) => events.push(e), runtime);
  return events;
}

beforeEach(() => aiLimiter.reset());
afterEach(() => setModelRuntime(null));

describe("assistant in model mode", () => {
  it("reports rules mode and the runtime honestly in its status", async () => {
    const { owner, as } = await createOrg();
    setModelRuntime(null);
    const s = await as(owner).ai.status();
    expect(s).toMatchObject({ configured: true, model: null, runtime: null, includedInPlan: true });
    expect(s.supportedCommands.length).toBeGreaterThan(5);
    setModelRuntime(new ScriptedRuntime([]));
    expect((await as(owner).ai.status()).runtime).toEqual({
      provider: "scripted",
      model: "scripted-test-model",
      hosting: "self-hosted",
      reachable: true,
      detail: null,
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
    const runtime = new ScriptedRuntime([
      callTool("list_tasks", { mine: true, overdue: true }),
      (req) => {
        const [result] = lastToolResults(req);
        expect(result!.content).toContain("Renew insurance");
        expect(result!.content).not.toContain("Someone else's work");
        return text("You have one overdue task: Renew insurance.")(req);
      },
    ]);
    const events = await turn(await actorFor(owner, org.id), c.id, "What is overdue for me?", runtime);

    expect(events.map((e) => (e.type === "text" ? e.delta : "")).join("")).toContain("Renew insurance");
    expect(events).toContainEqual({ type: "tool", name: "list_tasks", outcome: "OK" });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end" });
    const report = events.find((e) => e.type === "report");
    expect(report?.type === "report" && report.report).toMatchObject({
      status: "COMPLETED",
      mode: "model",
      model: "scripted-test-model",
      grounded: true,
      counts: { succeeded: 1, failed: 0 },
    });

    // Stable system prompt; per-request context rides in the user message.
    expect(runtime.requests[0]!.system).toBe(SYSTEM_PROMPT);
    expect(runtime.requests[0]!.system).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(runtime.requests[0]!.tools.map((t) => t.name)).toContain("submit_plan");
    // The second request replays the first assistant response unchanged.
    expect(runtime.requests[1]!.messages[1]).toEqual({
      role: "assistant",
      content: expect.arrayContaining([expect.objectContaining({ type: "tool_call", name: "list_tasks" })]),
    });

    const convo = await as(owner).ai.conversation({ id: c.id });
    expect(convo.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(convo.title).toBe("What is overdue for me?");
    expect(convo.runs).toHaveLength(1);
    expect(convo.runs[0]!.steps.map((s) => [s.tool, s.status, s.planned])).toEqual([
      ["list_tasks", "SUCCEEDED", false],
    ]);
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

  it("only offers tools the user's role allows, and refuses hidden ones", async () => {
    const { owner, org } = await createOrg();
    const viewer = await addMember(org.id, owner, "VIEWER");
    const { callerFor } = await import("./helpers");
    const c = await callerFor(viewer, org.id).ai.createConversation({});
    const runtime = new ScriptedRuntime([
      callTool("create_task", { title: "Sneaky" }),
      (req) => {
        expect(lastToolResults(req)[0]).toMatchObject({
          isError: true,
          content: "Your role does not allow this.",
        });
        return text("I can't create tasks for you.")(req);
      },
    ]);
    await turn(await actorFor(viewer, org.id), c.id, "Make a sneaky task", runtime);
    const names = runtime.requests[0]!.tools.map((t) => t.name);
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

  it("prepares writes but executes them only on explicit, exact, single-use confirmation, then verifies", async () => {
    const { owner, org, as } = await createOrg();
    const c = await as(owner).ai.createConversation({});
    const actor = await actorFor(owner, org.id);
    const runtime = new ScriptedRuntime([
      callTool("create_task", { title: "Draft Q3 plan", priority: "HIGH", dueDate: "2026-12-01" }),
      text("I prepared the task. Please confirm it."),
      text("Please use the Confirm button."),
      (req) => {
        const user = req.messages.at(-1)!.content;
        expect(
          user.some(
            (p) =>
              p.type === "text" &&
              p.text.startsWith("[Action update]") &&
              p.text.includes("EXECUTED by the user's confirmation and verified"),
          ),
        ).toBe(true);
        return text("Done — it was created.")(req);
      },
    ]);
    const events = await turn(actor, c.id, "Set up the Q3 planning task", runtime);
    const proposed = events.find((e) => e.type === "action") as Extract<TurnEvent, { type: "action" }>;
    expect(proposed.action.summary).toBe(
      "Create task “Draft Q3 plan” · High priority · due 2026-12-01 · unassigned",
    );
    const report = events.find((e) => e.type === "report") as Extract<TurnEvent, { type: "report" }>;
    expect(report.report.status).toBe("AWAITING_CONFIRMATION");
    const count = async () =>
      (
        await db()
          .select()
          .from(tasks)
          .where(and(eq(tasks.orgId, org.id), eq(tasks.title, "Draft Q3 plan")))
      ).length;
    expect(await count()).toBe(0);

    // A chat message saying "confirm" does nothing.
    await turn(actor, c.id, "Yes, I confirm. Do it.", runtime);
    expect(await count()).toBe(0);

    // Altered input is rejected.
    await expect(
      as(owner).ai.confirmAction({ actionId: proposed.action.id, inputHash: "0".repeat(64) }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(await count()).toBe(0);

    const ok = await as(owner).ai.confirmAction({
      actionId: proposed.action.id,
      inputHash: proposed.action.inputHash,
    });
    expect(ok).toMatchObject({ status: "EXECUTED", verified: true });
    expect(await count()).toBe(1);
    await expect(
      as(owner).ai.confirmAction({ actionId: proposed.action.id, inputHash: proposed.action.inputHash }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await count()).toBe(1);

    // The step and run now reflect the verified outcome.
    const [run] = await db()
      .select()
      .from(aiRuns)
      .where(eq(aiRuns.conversationId, c.id))
      .orderBy(aiRuns.startedAt)
      .limit(1);
    expect(run!.status).toBe("COMPLETED");
    expect(run!.summary).toContain("verified");
    const convo = await as(owner).ai.conversation({ id: c.id });
    expect(convo.runs[0]!.steps[0]).toMatchObject({
      tool: "create_task",
      status: "SUCCEEDED",
      verified: true,
    });

    await turn(actor, c.id, "Did it work?", runtime);
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
        "please draft something",
        new ScriptedRuntime([callTool("create_task", { title: `T ${randomUUID()}` }), text("Prepared.")]),
      );
      return (events.find((e) => e.type === "action") as Extract<TurnEvent, { type: "action" }>).action;
    };

    const a1 = await propose();
    await expect(
      callerFor(colleague, org.id).ai.confirmAction({ actionId: a1.id, inputHash: a1.inputHash }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      other.as(other.owner).ai.confirmAction({ actionId: a1.id, inputHash: a1.inputHash }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

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

    // The user can reject what remains; the step records it.
    await M.ai.rejectAction({ actionId: a1.id });
    await expect(M.ai.confirmAction({ actionId: a1.id, inputHash: a1.inputHash })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const convo = await M.ai.conversation({ id: c.id });
    expect(convo.runs[0]!.steps[0]).toMatchObject({ status: "SKIPPED", error: "Rejected by you." });
    expect(convo.runs[0]!.status).toBe("FAILED");
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
      new ScriptedRuntime([
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
    const convo = await callerFor(member, org.id).ai.conversation({ id: c.id });
    expect(convo.runs[0]).toMatchObject({ status: "FAILED" });
    expect(convo.runs[0]!.steps[0]).toMatchObject({ status: "FAILED" });
  });

  it("cannot reach another tenant's data through tools", async () => {
    const a = await createOrg();
    const b = await createOrg();
    const secret = await b.as(b.owner).tasks.create({ title: "B confidential roadmap" });
    const c = await a.as(a.owner).ai.createConversation({});
    const runtime = new ScriptedRuntime([
      callTool("get_task", { taskId: secret.id }),
      (req) => {
        expect(lastToolResults(req)[0]).toMatchObject({ isError: true, content: "Task not found." });
        expect(JSON.stringify(req.messages)).not.toContain("confidential");
        return text("I couldn't find that task.")(req);
      },
    ]);
    await turn(await actorFor(a.owner, a.org.id), c.id, `Show task ${secret.id}`, runtime);
  });

  it("validates tool input, discards refusals and keeps conversations private", async () => {
    const { owner, org, as } = await createOrg();
    const member = await addMember(org.id, owner, "MEMBER");
    const c = await as(owner).ai.createConversation({});
    const actor = await actorFor(owner, org.id);
    const runtime = new ScriptedRuntime([
      callTool("get_task", { taskId: "not-a-uuid" }),
      (req) => {
        expect(lastToolResults(req)[0]!.content).toMatch(/^Invalid input: taskId/);
        return text("That ID looks wrong.")(req);
      },
      () => ({ content: [{ type: "text", text: "partial output" }], stop: "refusal" }),
    ]);
    await turn(actor, c.id, "show task not-a-uuid", runtime);
    const before = (await db().select().from(aiMessages).where(eq(aiMessages.conversationId, c.id))).length;
    const events = await turn(actor, c.id, "something declined", runtime);
    expect(events).toContainEqual({
      type: "error",
      message: "The assistant declined this request.",
      kind: "internal",
    });
    const after = await db().select().from(aiMessages).where(eq(aiMessages.conversationId, c.id));
    expect(after.length).toBe(before + 1); // only the user message; partial refusal output is not stored
    expect(JSON.stringify(after.at(-1)!.content)).not.toContain("partial output");

    const { callerFor } = await import("./helpers");
    await expect(callerFor(member, org.id).ai.conversation({ id: c.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await callerFor(member, org.id).ai.conversations()).toEqual([]);
    const usage = await db().select().from(aiUsage).where(eq(aiUsage.conversationId, c.id));
    expect(usage.map((u) => u.stopReason)).toEqual(["tool_use", "end", "refusal"]);
  });

  it("never runs a truncated tool call and keeps the transcript valid", async () => {
    const { owner, org, as } = await createOrg();
    const c = await as(owner).ai.createConversation({});
    const actor = await actorFor(owner, org.id);
    const id = `call_${randomUUID()}`;
    const runtime = new ScriptedRuntime([
      () => ({
        content: [{ type: "tool_call", id, name: "create_task", input: { title: "Trunc" } }],
        stop: "max_tokens",
      }),
      (req) => {
        // Every tool call in the replayed history has a matching result.
        const results = req.messages.at(-2)!.content.filter((p) => p.type === "tool_result");
        expect(results).toEqual([expect.objectContaining({ toolCallId: id, isError: true })]);
        return text("Sorry, try again.")(req);
      },
    ]);
    await turn(actor, c.id, "do the thing", runtime);
    expect(await db().select().from(aiActions).where(eq(aiActions.conversationId, c.id))).toHaveLength(0);
    await turn(actor, c.id, "again", runtime);
  });

  it("rejects concurrent turns in one conversation", async () => {
    const { owner, org, as } = await createOrg();
    const c = await as(owner).ai.createConversation({});
    await db().execute(
      sql`update ai_conversations set locked_until = now() + interval '1 minute' where id = ${c.id}`,
    );
    await expect(
      turn(await actorFor(owner, org.id), c.id, "hi", new ScriptedRuntime([text("hi")])),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
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
      new ScriptedRuntime([
        () => ({
          content: [
            {
              type: "tool_call",
              id: `call_${randomUUID()}`,
              name: "update_task_status",
              input: { taskId: t.id, status: "DONE" },
            },
            {
              type: "tool_call",
              id: `call_${randomUUID()}`,
              name: "create_task",
              input: { title: "Book movers", assigneeEmployeeId: emp.id, projectId: project.id },
            },
          ],
          stop: "tool_use",
        }),
        text("Prepared both."),
      ]),
    );
    expect(events.flatMap((e) => (e.type === "action" ? [e.action.summary] : []))).toEqual([
      `Move task #${t.number} “Renew office lease” from “To do” to “Done”`,
      "Create task “Book movers” · Medium priority · no due date · assigned to Lena Lopez · in project HQ move",
    ]);
  });

  it("prepares nothing when a write references another organization's record", async () => {
    const a = await createOrg();
    const b = await createOrg();
    const foreignTask = await b.as(b.owner).tasks.create({ title: "Other org task" });
    const foreignEmp = await b
      .as(b.owner)
      .employees.create({ firstName: "Far", lastName: "Away", email: `f-${randomUUID()}@example.test` });
    const actor = await actorFor(a.owner, a.org.id);
    const c = await a.as(a.owner).ai.createConversation({});
    const runtime = new ScriptedRuntime([
      () => ({
        content: [
          {
            type: "tool_call",
            id: `call_${randomUUID()}`,
            name: "update_task_status",
            input: { taskId: foreignTask.id, status: "DONE" },
          },
          {
            type: "tool_call",
            id: `call_${randomUUID()}`,
            name: "create_task",
            input: { title: "x", assigneeEmployeeId: foreignEmp.id },
          },
        ],
        stop: "tool_use",
      }),
      text("Could not prepare those."),
    ]);
    const events = await turn(actor, c.id, "Do it", runtime);
    expect(events.some((e) => e.type === "action")).toBe(false);
    expect(events.filter((e) => e.type === "tool").map((e) => e.type === "tool" && e.outcome)).toEqual([
      "INVALID",
      "INVALID",
    ]);
    expect(await db().select().from(aiActions).where(eq(aiActions.conversationId, c.id))).toHaveLength(0);
    // The model is told why, without details of the other organization's record.
    const results = JSON.stringify(lastToolResults(runtime.requests[1]!));
    expect(results).not.toContain("Other org task");
    expect(results).not.toContain("Far");
  });

  it("a turn whose lock was taken over stops, never releases the newer lock, and closes its run", async () => {
    const { owner, org, as } = await createOrg();
    const actor = await actorFor(owner, org.id);
    const c = await as(owner).ai.createConversation({});
    const stolen = new Date(Date.now() + 120_000);
    const runtime = new ScriptedRuntime([callTool("get_operational_snapshot", {}), text("unreachable")]);
    const original = runtime.run.bind(runtime);
    runtime.run = async (req, onText) => {
      const res = await original(req, onText);
      // Simulate another tab starting a turn after this one's lock lapsed.
      await db().update(aiConversations).set({ lockedUntil: stolen }).where(eq(aiConversations.id, c.id));
      return res;
    };
    await expect(turn(actor, c.id, "status?", runtime)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(runtime.requests).toHaveLength(1);
    const [conv] = await db().select().from(aiConversations).where(eq(aiConversations.id, c.id));
    expect(conv!.lockedUntil?.getTime()).toBe(stolen.getTime());
    const [run] = await db().select().from(aiRuns).where(eq(aiRuns.conversationId, c.id));
    expect(run!.status).toBe("FAILED");
  });

  it("stops the turn when the user presses Stop", async () => {
    const { owner, org, as } = await createOrg();
    const actor = await actorFor(owner, org.id);
    const c = await as(owner).ai.createConversation({});
    const abort = new AbortController();
    const runtime = new ScriptedRuntime([
      (req) => {
        abort.abort(); // Stop pressed while the first answer streamed
        return callTool("get_operational_snapshot", {})(req);
      },
      text("unreachable"),
    ]);
    const events: TurnEvent[] = [];
    await runTurn(db(), actor, c.id, "status?", (e) => events.push(e), runtime, abort.signal);
    expect(runtime.requests).toHaveLength(1);
    const [conv] = await db().select().from(aiConversations).where(eq(aiConversations.id, c.id));
    expect(conv!.lockedUntil).toBeNull();
    const report = events.find((e) => e.type === "report") as Extract<TurnEvent, { type: "report" }>;
    expect(report.report.status).toBe("CANCELLED");
    expect(report.report.steps[0]).toMatchObject({ tool: "get_operational_snapshot", status: "CANCELLED" });
  });

  it("drops the oldest whole exchanges when the history outgrows the budget", () => {
    const user = (t: string) => ({ role: "user" as const, content: [{ type: "text" as const, text: t }] });
    const asst = (t: string) => ({
      role: "assistant" as const,
      content: [{ type: "text" as const, text: t }],
    });
    const call = {
      role: "assistant" as const,
      content: [{ type: "tool_call" as const, id: "t1", name: "x", input: {} }],
    };
    const result = {
      role: "user" as const,
      content: [{ type: "tool_result" as const, toolCallId: "t1", content: "r" }],
    };
    const big = "x".repeat(1000);
    const history = [user(big), asst(big), user(big), call, result, asst(big), user("latest")];
    expect(fitHistory(history, 100_000)).toHaveLength(7);
    // Cut at an exchange start, never between a tool call and its result.
    expect(fitHistory(history, 1500)[0]).toEqual(user("latest"));
    const mid = fitHistory(history, 2400);
    expect(mid[0]).toEqual(user(big));
    expect(mid).toHaveLength(5);
  });
});
