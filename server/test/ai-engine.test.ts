import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addDaysISO, todayISO } from "../src/lib/dates";
import { aiActions, aiMemories, aiRuns, aiUsage, notifications, tasks } from "../src/db/schema";
import { aiLimiter, runTurn, type TurnEvent } from "../src/modules/ai/assistant";
import { memoryContext, purgeExpiredMemories } from "../src/modules/ai/memory";
import { LIMITS } from "../src/modules/ai/policy";
import { ModelUnavailableError, setModelRuntime, type ModelRuntime } from "../src/modules/ai/runtime";
import { TOOLS, type ToolDef } from "../src/modules/ai/tools";
import { z } from "zod";
import { actorFor, callTool, lastToolResults, ScriptedRuntime, text } from "./ai-helpers";
import { addMember, callerFor, createOrg, db, type TestUser } from "./helpers";

beforeEach(() => aiLimiter.reset());
afterEach(() => setModelRuntime(null));

async function ask(
  user: TestUser,
  orgId: string,
  conversationId: string,
  message: string,
  runtime: ModelRuntime | null = null,
  signal?: AbortSignal,
) {
  const events: TurnEvent[] = [];
  await runTurn(
    db(),
    await actorFor(user, orgId),
    conversationId,
    message,
    (e) => events.push(e),
    runtime,
    signal,
  );
  const answer = events.map((e) => (e.type === "text" ? e.delta : "")).join("");
  const report = (
    events.find((e) => e.type === "report") as Extract<TurnEvent, { type: "report" }> | undefined
  )?.report;
  const actions = events.flatMap((e) => (e.type === "action" ? [e.action] : []));
  return { events, answer, report, actions };
}

const ago = (days: number) => addDaysISO(todayISO(), -days);

describe("rules mode (no model)", () => {
  it("prioritizes from real records with documented, checkable reasons and spends no model request", async () => {
    const { owner, org, as } = await createOrg();
    const me = (await as(owner).employees.me())!;
    await as(owner).tasks.create({
      title: "Low and very late",
      priority: "LOW",
      dueDate: ago(20),
      assigneeEmployeeId: me.id,
    });
    await as(owner).tasks.create({
      title: "Urgent and late",
      priority: "URGENT",
      dueDate: ago(5),
      assigneeEmployeeId: me.id,
    });
    await as(owner).tasks.create({ title: "Someone else's", priority: "URGENT", dueDate: ago(9) });
    const c = await as(owner).ai.createConversation({});

    const r = await ask(owner, org.id, c.id, "What should I prioritize today?");
    expect(r.events[0]).toMatchObject({
      type: "run",
      run: { mode: "rules", intent: "priorities", model: null },
    });
    expect(r.events.find((e) => e.type === "plan")).toMatchObject({
      steps: [expect.objectContaining({ tool: "analyze_priorities", status: "PENDING", planned: true })],
    });
    // Urgent: 40 + 30 + 5×2 = 80; Low: 0 + 30 + 30 (capped) = 60.
    expect(r.answer.indexOf("Urgent and late")).toBeLessThan(r.answer.indexOf("Low and very late"));
    expect(r.answer).toContain("5 days overdue");
    expect(r.answer).not.toContain("Someone else's");
    expect(r.answer).toContain("How this is ranked");
    expect(r.report).toMatchObject({ status: "COMPLETED", mode: "rules", counts: { succeeded: 1 } });
    expect(r.report!.evidence.map((e) => e.label)).toEqual(
      expect.arrayContaining([expect.stringContaining("Urgent and late")]),
    );
    expect(await db().select().from(aiUsage).where(eq(aiUsage.conversationId, c.id))).toHaveLength(0);
  });

  it("ranks overdue tasks by urgency and says when there are none", async () => {
    const { owner, org, as } = await createOrg();
    const c = await as(owner).ai.createConversation({});
    expect((await ask(owner, org.id, c.id, "Any overdue tasks?")).answer).toBe("There are no overdue tasks.");
    await as(owner).tasks.create({ title: "Medium late", priority: "MEDIUM", dueDate: ago(30) });
    await as(owner).tasks.create({ title: "High late", priority: "HIGH", dueDate: ago(2) });
    const r = await ask(owner, org.id, c.id, "What are the most urgent overdue tasks?");
    // High: 3×10 + 2 + 5 (unassigned) = 37; Medium: 2×10 + 30 + 5 = 55.
    expect(r.answer).toMatch(/^2 overdue tasks\. Most urgent first:\n1\. #\d+ Medium late/);
    expect(r.answer).toContain("Unassigned: nobody owns it");
  });

  it("finds blocked projects with evidence and states what FLOWOS cannot know", async () => {
    const { owner, org, as } = await createOrg();
    const stuck = await as(owner).projects.create({ name: "Warehouse move" });
    await as(owner).projects.create({ name: "Quiet project" });
    const t = await as(owner).tasks.create({ title: "Wait for permit", projectId: stuck.id });
    await as(owner).tasks.update({ id: t.id, status: "BLOCKED" });
    const c = await as(owner).ai.createConversation({});
    const r = await ask(owner, org.id, c.id, "Which projects are blocked?");
    expect(r.answer).toContain("Appear blocked (1)");
    expect(r.answer).toContain("Warehouse move");
    expect(r.answer).toContain("Wait for permit");
    expect(r.answer).not.toContain("Quiet project");
    expect(r.report!.notes.join(" ")).toContain("no dependencies between tasks");
  });

  it("refuses to guess at unsupported requests and lists what works", async () => {
    const { owner, org, as } = await createOrg();
    const c = await as(owner).ai.createConversation({});
    const r = await ask(owner, org.id, c.id, "Write a motivational speech for the sales team");
    expect(r.answer).toMatch(/^I can't interpret that request without a language model\. I won't guess\./);
    expect(r.answer).toContain("What should I prioritize today?");
    expect(r.report).toMatchObject({ status: "COMPLETED", steps: [] });
    expect(r.events[0]).toMatchObject({
      run: { intent: null, objective: "Request not recognised without a model" },
    });
  });

  it("plans a multi-step change: resolves people and project, prepares, confirms, verifies and remembers", async () => {
    const { owner, org, as } = await createOrg();
    const lena = await as(owner).employees.create({
      firstName: "Lena",
      lastName: "Lopez",
      email: `l-${randomUUID()}@e.test`,
    });
    const project = await as(owner).projects.create({ name: "HQ move" });
    const c = await as(owner).ai.createConversation({});
    const r = await ask(
      owner,
      org.id,
      c.id,
      "Create task Book movers due tomorrow for Lena Lopez in project HQ move high priority",
    );
    expect(r.report!.steps.map((s) => [s.tool, s.status])).toEqual([
      ["search_people", "SUCCEEDED"],
      ["list_projects", "SUCCEEDED"],
      ["create_task", "AWAITING_CONFIRMATION"],
    ]);
    expect(r.report!.status).toBe("AWAITING_CONFIRMATION");
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.summary).toBe(
      `Create task “Book movers” · High priority · due ${addDaysISO(todayISO(), 1)} · assigned to Lena Lopez · in project HQ move`,
    );
    expect(r.answer).toMatch(/^I prepared this change\. Nothing changes until you confirm it below/);
    expect(
      await db()
        .select()
        .from(tasks)
        .where(and(eq(tasks.orgId, org.id), eq(tasks.title, "Book movers"))),
    ).toHaveLength(0);

    const res = await as(owner).ai.confirmAction({
      actionId: r.actions[0]!.id,
      inputHash: r.actions[0]!.inputHash,
    });
    expect(res).toMatchObject({ status: "EXECUTED", verified: true });
    const [created] = await db()
      .select()
      .from(tasks)
      .where(and(eq(tasks.orgId, org.id), eq(tasks.title, "Book movers")));
    expect(created).toMatchObject({ assigneeEmployeeId: lena.id, projectId: project.id, priority: "HIGH" });
    const convo = await as(owner).ai.conversation({ id: c.id });
    expect(convo.runs[0]).toMatchObject({ status: "COMPLETED" });
    expect(convo.runs[0]!.steps[2]).toMatchObject({ status: "SUCCEEDED", verified: true });
    const mem = await as(owner).ai.memories();
    expect(mem.items).toEqual([
      expect.objectContaining({
        scope: "OUTCOME",
        source: "engine",
        content: expect.stringContaining("Book movers"),
      }),
    ]);
  });

  it("skips a step it cannot resolve instead of guessing", async () => {
    const { owner, org, as } = await createOrg();
    await as(owner).employees.create({
      firstName: "Sam",
      lastName: "Stone",
      email: `s1-${randomUUID()}@e.test`,
    });
    await as(owner).employees.create({
      firstName: "Sam",
      lastName: "Silva",
      email: `s2-${randomUUID()}@e.test`,
    });
    const c = await as(owner).ai.createConversation({});
    const r = await ask(owner, org.id, c.id, "create task Call the bank for Sam");
    expect(r.report!.steps[1]).toMatchObject({ tool: "create_task", status: "SKIPPED" });
    expect(r.report!.steps[1]!.error).toMatch(
      /^2 persons match “Sam” \(Sam Silva, Sam Stone\); say which one\.$/,
    );
    expect(r.actions).toHaveLength(0);
    expect(r.report!.status).toBe("PARTIAL");
    expect(r.answer).toContain("Not done:");
  });

  it("re-plans after observing results: one follow-up per blocked task, each confirmed separately", async () => {
    const { owner, org, as } = await createOrg();
    const p = await as(owner).projects.create({ name: "Launch" });
    for (const title of ["Legal sign-off", "Vendor contract"]) {
      const t = await as(owner).tasks.create({ title, projectId: p.id });
      await as(owner).tasks.update({ id: t.id, status: "BLOCKED" });
    }
    const c = await as(owner).ai.createConversation({});
    const r = await ask(owner, org.id, c.id, "Create follow-up tasks for blocked tasks in project Launch");
    expect(r.report!.steps.map((s) => [s.tool, s.status])).toEqual([
      ["list_projects", "SUCCEEDED"],
      ["list_tasks", "SUCCEEDED"],
      ["create_task", "AWAITING_CONFIRMATION"],
      ["create_task", "AWAITING_CONFIRMATION"],
    ]);
    const convo = await as(owner).ai.conversation({ id: c.id });
    // The follow-ups were added after observing step 2, not in the original plan.
    expect(convo.runs[0]!.steps.map((s) => s.planned)).toEqual([true, true, false, false]);
    expect(r.actions.map((a) => a.summary).sort()).toEqual([
      expect.stringMatching(
        /^Create task “Follow up on blocked #\d+: Legal sign-off” · High priority · due .* in project Launch/,
      ),
      expect.stringMatching(/^Create task “Follow up on blocked #\d+: Vendor contract”/),
    ]);
    await as(owner).ai.confirmAction({ actionId: r.actions[0]!.id, inputHash: r.actions[0]!.inputHash });
    await as(owner).ai.rejectAction({ actionId: r.actions[1]!.id });
    const after = await as(owner).ai.conversation({ id: c.id });
    expect(after.runs[0]!.status).toBe("PARTIAL");
    expect(after.runs[0]!.report!.counts).toMatchObject({ succeeded: 3, skipped: 1, pending: 0 });
  });

  it("voids a confirmation when the record changed after it was prepared", async () => {
    const { owner, org, as } = await createOrg();
    const t = await as(owner).tasks.create({ title: "Ship release notes" });
    const c = await as(owner).ai.createConversation({});
    const r = await ask(owner, org.id, c.id, `Mark #${t.number} as done`);
    expect(r.actions[0]!.summary).toBe(`Move task #${t.number} “Ship release notes” from “To do” to “Done”`);
    // Someone moves the task in the meantime: the card no longer describes reality.
    await as(owner).tasks.update({ id: t.id, status: "BLOCKED" });
    const res = await as(owner).ai.confirmAction({
      actionId: r.actions[0]!.id,
      inputHash: r.actions[0]!.inputHash,
    });
    expect(res).toMatchObject({
      status: "FAILED",
      error: expect.stringContaining("changed since this was prepared"),
    });
    expect((await as(owner).tasks.get({ id: t.id })).status).toBe("BLOCKED");
    expect((await as(owner).ai.conversation({ id: c.id })).runs[0]!.status).toBe("PARTIAL");

    // Asking again for a task already in that state prepares nothing.
    const again = await ask(owner, org.id, c.id, `mark #${t.number} as blocked`);
    expect(again.report!.steps[1]).toMatchObject({
      status: "SKIPPED",
      error: `#${t.number} is already “Blocked”.`,
    });
  });

  it("enforces the role in rules mode too: a viewer's write is refused", async () => {
    const { owner, org } = await createOrg();
    const viewer = await addMember(org.id, owner, "VIEWER");
    const c = await callerFor(viewer, org.id).ai.createConversation({});
    const r = await ask(viewer, org.id, c.id, "create task Order chairs");
    expect(r.report!.steps.at(-1)).toMatchObject({
      tool: "create_task",
      status: "FAILED",
      error: "Your role does not allow this.",
    });
    expect(await db().select().from(aiActions).where(eq(aiActions.conversationId, c.id))).toHaveLength(0);
  });

  it("runs a low-risk action on the user's own data automatically, verifies and audits it", async () => {
    const { owner, org, as } = await createOrg();
    const member = await addMember(org.id, owner, "MEMBER");
    for (const userId of [owner.id, owner.id, member.id])
      await db()
        .insert(notifications)
        .values({ orgId: org.id, userId, type: "MEMBER_JOINED", title: "Ping" });
    const unread = await as(owner).notifications.unreadCount();
    expect(unread).toBeGreaterThanOrEqual(2);
    const c = await as(owner).ai.createConversation({});
    const r = await ask(owner, org.id, c.id, "Mark my notifications as read");
    expect(r.answer).toBe(`Marked ${unread} notifications as read.`);
    expect(await as(owner).notifications.unreadCount()).toBe(0);
    expect(r.report!.steps[0]).toMatchObject({
      tool: "mark_notifications_read",
      status: "SUCCEEDED",
      verified: true,
    });
    expect(r.actions).toHaveLength(0);
    // Another user's inbox is untouched.
    expect(await callerFor(member, org.id).notifications.unreadCount()).toBe(1);
    expect((await as(owner).audit.list({})).items.map((e) => e.action)).toContain("ai.notifications_read");
  });

  it("stops: steps that had not run are cancelled and nothing else happens", async () => {
    const { owner, org, as } = await createOrg();
    const c = await as(owner).ai.createConversation({});
    const abort = new AbortController();
    abort.abort();
    const r = await ask(owner, org.id, c.id, "create task Never happens", null, abort.signal);
    expect(r.report).toMatchObject({
      status: "CANCELLED",
      steps: [expect.objectContaining({ status: "CANCELLED" })],
    });
    expect(await db().select().from(aiActions).where(eq(aiActions.conversationId, c.id))).toHaveLength(0);
  });
});

describe("recovery, limits and model availability", () => {
  const added: ToolDef[] = [];
  const addTool = (t: ToolDef) => {
    (TOOLS as ToolDef[]).push(t);
    added.push(t);
  };
  afterEach(() => {
    for (const t of added.splice(0)) (TOOLS as ToolDef[]).splice((TOOLS as ToolDef[]).indexOf(t), 1);
    (LIMITS as { stepTimeoutMs: number }).stepTimeoutMs = 15_000;
  });
  const flaky = (failures: number, error: () => Error) => {
    let calls = 0;
    return {
      name: `flaky_${randomUUID().slice(0, 8)}`,
      description: "test",
      schema: z.object({}),
      inputSchema: {},
      permissions: [],
      risk: "read" as const,
      execute: async () => {
        if (calls++ < failures) throw error();
        return { ok: true, calls };
      },
      summarize: () => "ok",
    };
  };
  const transient = () => Object.assign(new Error("deadlock detected"), { code: "40P01" });

  it("retries a transient read failure a bounded number of times", async () => {
    const { owner, org, as } = await createOrg();
    const once = flaky(1, transient);
    const always = flaky(99, transient);
    const domain = flaky(99, () => Object.assign(new Error("Task not found."), { name: "AppError" }));
    [once, always, domain].forEach(addTool);
    const c = await as(owner).ai.createConversation({});
    const runtime = new ScriptedRuntime([
      callTool(once.name, {}),
      callTool(always.name, {}),
      callTool(domain.name, {}),
      text("Reported."),
    ]);
    const r = await ask(owner, org.id, c.id, "check", runtime);
    expect(r.report!.steps.map((s) => s.status)).toEqual(["SUCCEEDED", "FAILED", "FAILED"]);
    const convo = await as(owner).ai.conversation({ id: c.id });
    expect(convo.runs[0]!.steps.map((s) => s.attempts)).toEqual([2, 1 + LIMITS.maxReadRetries, 1]);
    expect(r.report!.status).toBe("PARTIAL");
  });

  it("times out a slow step and reports it", async () => {
    const { owner, org, as } = await createOrg();
    (LIMITS as { stepTimeoutMs: number }).stepTimeoutMs = 50;
    const slow: ToolDef = {
      ...flaky(0, transient),
      name: `slow_${randomUUID().slice(0, 8)}`,
      execute: () => new Promise((r) => setTimeout(() => r({ late: true }), 1000)),
    };
    addTool(slow);
    const c = await as(owner).ai.createConversation({});
    const runtime = new ScriptedRuntime([
      callTool(slow.name, {}),
      (req) => {
        expect(lastToolResults(req)[0]).toMatchObject({
          isError: true,
          content: "The step took longer than 0.05s.",
        });
        return text("It timed out.")(req);
      },
    ]);
    const r = await ask(owner, org.id, c.id, "slow please", runtime);
    expect(r.report!.steps[0]).toMatchObject({ status: "FAILED" });
  });

  it("prevents loops: the same call is refused the third time", async () => {
    const { owner, org, as } = await createOrg();
    const c = await as(owner).ai.createConversation({});
    const runtime = new ScriptedRuntime([
      callTool("list_tasks", { overdue: true }),
      callTool("list_tasks", { overdue: true }),
      callTool("list_tasks", { overdue: true }),
      (req) => {
        expect(lastToolResults(req)[0]).toMatchObject({
          isError: true,
          content: "The same call was already made twice in this request.",
        });
        return text("Stopping.")(req);
      },
    ]);
    const r = await ask(owner, org.id, c.id, "loop", runtime);
    expect(r.report!.steps.map((s) => s.status)).toEqual(["SUCCEEDED", "SUCCEEDED", "FAILED"]);
  });

  it("stops after the model request limit", async () => {
    const { owner, org, as } = await createOrg();
    const c = await as(owner).ai.createConversation({});
    const runtime = new ScriptedRuntime(
      Array.from({ length: LIMITS.maxModelRequests + 2 }, (_, i) => callTool("list_tasks", { limit: i + 1 })),
    );
    const r = await ask(owner, org.id, c.id, "go on forever", runtime);
    expect(runtime.requests).toHaveLength(LIMITS.maxModelRequests);
    expect(r.events).toContainEqual(expect.objectContaining({ type: "error", kind: "limit" }));
  });

  it("validates a model's plan against the user's tools and reports unexecuted steps", async () => {
    const { owner, org } = await createOrg();
    const viewer = await addMember(org.id, owner, "VIEWER");
    const c = await callerFor(viewer, org.id).ai.createConversation({});
    const runtime = new ScriptedRuntime([
      callTool("submit_plan", {
        objective: "Tidy up overdue work",
        steps: [
          { tool: "analyze_overdue_tasks", purpose: "Find what is late" },
          { tool: "create_task", purpose: "Add a reminder" },
          { tool: "drop_database", purpose: "Clean up" },
          { tool: "list_projects", purpose: "Check projects" },
        ],
      }),
      (req) => {
        const reply = JSON.parse(lastToolResults(req)[0]!.content) as {
          accepted: unknown[];
          rejected: Array<{ tool: string; reason: string }>;
        };
        expect(reply.accepted).toHaveLength(2);
        expect(reply.rejected).toEqual([
          { tool: "create_task", reason: "Not an available tool for this user." },
          { tool: "drop_database", reason: "Not an available tool for this user." },
        ]);
        return callTool("analyze_overdue_tasks", {})(req);
      },
      text("Nothing is overdue."),
    ]);
    const r = await ask(viewer, org.id, c.id, "tidy up", runtime);
    expect(r.events[0]).toMatchObject({ type: "run", run: { mode: "model" } });
    expect(r.report!.objective).toBe("Tidy up overdue work");
    expect(r.report!.steps.map((s) => [s.tool, s.status])).toEqual([
      ["analyze_overdue_tasks", "SUCCEEDED"],
      ["list_projects", "SKIPPED"],
    ]);
    expect(r.report!.steps[1]!.error).toBe("Not run: the model did not execute this step.");
  });

  it("flags an answer that consulted no FLOWOS records", async () => {
    const { owner, org, as } = await createOrg();
    const c = await as(owner).ai.createConversation({});
    const r = await ask(
      owner,
      org.id,
      c.id,
      "how are we doing?",
      new ScriptedRuntime([text("Everything is great, 12 projects on track!")]),
    );
    expect(r.report).toMatchObject({ grounded: false });
    expect(r.report!.notes).toContain("This answer did not use any FLOWOS records. Treat it as unverified.");
  });

  it("distinguishes an unavailable model: falls back to FLOWOS rules for supported commands, never to another provider", async () => {
    const { owner, org, as } = await createOrg();
    const down: ModelRuntime = {
      info: { provider: "openai-compatible", model: "local-model", hosting: "self-hosted" },
      health: async () => ({ ok: false, detail: "connection failed" }),
      run: async () => {
        throw new ModelUnavailableError("The model runtime could not be reached.");
      },
    };
    const c = await as(owner).ai.createConversation({});
    process.env.FLOWOS_ASSISTANT_ROUTING = "model-first";
    const supported = await ask(owner, org.id, c.id, "Which approvals are waiting for me?", down).finally(
      () => delete process.env.FLOWOS_ASSISTANT_ROUTING,
    );
    expect(supported.events).toContainEqual({
      type: "error",
      kind: "model_unavailable",
      message: "The model runtime is unavailable (The model runtime could not be reached.).",
    });
    expect(supported.answer).toBe("No approval requests are waiting for your decision.");
    expect(supported.report).toMatchObject({ mode: "rules", status: "COMPLETED" });
    expect(supported.report!.notes).toContain(
      "The model runtime is unavailable; FLOWOS answered with its own rules.",
    );

    const other = await ask(owner, org.id, c.id, "Draft a note to the board", down);
    expect(other.answer).toMatch(/^I can't interpret that request \(the model is not available for it\)/);
    const runs = await db()
      .select()
      .from(aiRuns)
      .where(eq(aiRuns.conversationId, c.id))
      .orderBy(aiRuns.startedAt);
    expect(runs.map((x) => [x.mode, x.status])).toEqual([
      ["model", "FAILED"],
      ["rules", "COMPLETED"],
      ["model", "FAILED"],
      ["rules", "COMPLETED"],
    ]);
    expect(runs[0]!.error).toBe("Model unavailable: The model runtime could not be reached.");
  });
});

describe("routing", () => {
  it("rules-first (default): supported commands never reach the model, other requests do", async () => {
    const { owner, org, as } = await createOrg();
    const c = await as(owner).ai.createConversation({});
    const runtime = new ScriptedRuntime([text("A free-form answer.")]);
    const known = await ask(owner, org.id, c.id, "Which approvals are waiting for me?", runtime);
    expect(runtime.requests).toHaveLength(0);
    expect(known.report).toMatchObject({ mode: "rules", status: "COMPLETED" });
    const other = await ask(owner, org.id, c.id, "Summarize our week in one sentence", runtime);
    expect(runtime.requests).toHaveLength(1);
    expect(other.report).toMatchObject({ mode: "model", grounded: false });
    expect((await as(owner).ai.status()).routing).toBe("rules-first");
  });

  it("model-first: the model plans supported commands too", async () => {
    const { owner, org, as } = await createOrg();
    const c = await as(owner).ai.createConversation({});
    const runtime = new ScriptedRuntime([callTool("list_my_approvals", {}), text("None waiting.")]);
    process.env.FLOWOS_ASSISTANT_ROUTING = "model-first";
    try {
      const r = await ask(owner, org.id, c.id, "Which approvals are waiting for me?", runtime);
      expect(r.report).toMatchObject({ mode: "model", grounded: true });
      expect(runtime.requests).toHaveLength(2);
    } finally {
      delete process.env.FLOWOS_ASSISTANT_ROUTING;
    }
  });
});

describe("memory", () => {
  it("saves what the user explicitly asked to remember, scoped to them, and never through a model", async () => {
    const { owner, org, as } = await createOrg();
    const colleague = await addMember(org.id, owner, "MANAGER");
    const other = await createOrg();
    const c = await as(owner).ai.createConversation({});
    // Even with a model configured, "remember" is handled by FLOWOS rules: the model is never asked.
    const runtime = new ScriptedRuntime([]);
    const r = await ask(
      owner,
      org.id,
      c.id,
      "Remember that I review approvals first thing in the morning",
      runtime,
    );
    expect(runtime.requests).toHaveLength(0);
    expect(r.answer).toContain("Saved.");
    const mine = await as(owner).ai.memories();
    expect(mine.items).toEqual([
      expect.objectContaining({
        scope: "PREFERENCE",
        source: "user",
        content: "I review approvals first thing in the morning",
      }),
    ]);
    expect((await callerFor(colleague, org.id).ai.memories()).items).toEqual([]);
    expect((await other.as(other.owner).ai.memories()).items).toEqual([]);
    // Someone else's entry is invisible, so it cannot be deleted either.
    await expect(
      callerFor(colleague, org.id).ai.deleteMemory({ id: mine.items[0]!.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.as(other.owner).ai.deleteMemory({ id: mine.items[0]!.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("organization knowledge is written by managers of the org, read by members, isolated per tenant", async () => {
    const { owner, org, as } = await createOrg();
    const member = await addMember(org.id, owner, "MEMBER");
    const other = await createOrg();
    await expect(
      callerFor(member, org.id).ai.addMemory({
        scope: "ORG_KNOWLEDGE",
        content: "Fiscal year starts in April",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const k = await as(owner).ai.addMemory({
      scope: "ORG_KNOWLEDGE",
      content: "Fiscal year starts in April",
    });
    expect((await callerFor(member, org.id).ai.memories()).items.map((m) => m.content)).toEqual([
      "Fiscal year starts in April",
    ]);
    expect((await other.as(other.owner).ai.memories()).items).toEqual([]);
    await expect(callerFor(member, org.id).ai.deleteMemory({ id: k.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // A model receives it as labelled context, alongside the user's own preferences only.
    await callerFor(member, org.id).ai.addMemory({ scope: "PREFERENCE", content: "Keep answers short" });
    await as(owner).ai.addMemory({ scope: "PREFERENCE", content: "Owner-only preference" });
    const c = await callerFor(member, org.id).ai.createConversation({});
    const runtime = new ScriptedRuntime([text("Noted.")]);
    await ask(member, org.id, c.id, "hello there", runtime);
    const sent = JSON.stringify(runtime.requests[0]!.messages);
    expect(sent).toContain("[Memory]");
    expect(sent).toContain("Fiscal year starts in April");
    expect(sent).toContain("Keep answers short");
    expect(sent).not.toContain("Owner-only preference");
    // The memory note is for the model; the transcript shows only what the user wrote.
    const convo = await callerFor(member, org.id).ai.conversation({ id: c.id });
    expect(convo.items.filter((i) => i.kind === "user").map((i) => i.kind === "user" && i.text)).toEqual([
      "hello there",
    ]);
  });

  it("clears personal memory on request and purges expired outcomes", async () => {
    const { owner, org, as } = await createOrg();
    await as(owner).ai.addMemory({ scope: "PREFERENCE", content: "Prefers bullet lists" });
    await db()
      .insert(aiMemories)
      .values({
        orgId: org.id,
        userId: owner.id,
        scope: "OUTCOME",
        content: "Old outcome",
        source: "engine",
        expiresAt: new Date(Date.now() - 1000),
      });
    expect((await as(owner).ai.memories()).items.map((m) => m.content)).toEqual(["Prefers bullet lists"]);
    expect(await purgeExpiredMemories(db())).toBeGreaterThanOrEqual(1);
    expect(await as(owner).ai.clearMyMemory()).toEqual({ removed: 1 });
    expect((await as(owner).ai.memories()).items).toEqual([]);
    // The database refuses an outcome claimed by a user (outcomes come only from verified engine actions).
    await expect(
      db()
        .insert(aiMemories)
        .values({ orgId: org.id, userId: owner.id, scope: "OUTCOME", content: "fake", source: "user" }),
    ).rejects.toThrow();
  });

  it("offers summaries of the user's earlier requests in other conversations only", async () => {
    const { owner, org, as } = await createOrg();
    const c1 = await as(owner).ai.createConversation({});
    await ask(owner, org.id, c1.id, "Which approvals are waiting for me?");
    const c2 = await as(owner).ai.createConversation({});
    const ctx = await memoryContext(db(), await actorFor(owner, org.id), c2.id);
    expect(ctx.previousRuns).toEqual([
      expect.stringContaining("List approvals waiting for your decision — completed"),
    ]);
    expect((await memoryContext(db(), await actorFor(owner, org.id), c1.id)).previousRuns).toEqual([]);
  });
});
