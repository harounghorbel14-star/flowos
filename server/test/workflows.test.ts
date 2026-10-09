import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ONBOARDING_TEMPLATE, type WorkflowAction } from "@shared/workflows";
import { domainEvents, tasks, workflowRuns, workflowRunSteps } from "../src/db/schema";
import { executeAction } from "../src/modules/workflows/actions";
import { dispatchEvents, MAX_DEPTH, runDueWorkflows, runWorkerOnce } from "../src/modules/workflows/engine";
import { addMember, createOrg, createUser, db } from "./helpers";

const email = () => `wf-${randomUUID()}@example.test`;

/** Drain the queue: dispatch + run until nothing is left to do right now. */
async function drain() {
  for (let i = 0; i < 5; i++) {
    const { dispatched, results } = await runWorkerOnce(db());
    if (dispatched === 0 && results.length === 0) return;
  }
}

async function onboardingSetup() {
  const ctx = await createOrg();
  const { owner, org, as } = ctx;
  const managerUser = await addMember(org.id, owner, "MANAGER", "Mo Manager");
  const manager = await as(owner).employees.create({
    firstName: "Mo",
    lastName: "Manager",
    email: email(),
    userId: managerUser.id,
  });
  const wf = await as(owner).workflows.create({
    name: ONBOARDING_TEMPLATE.name,
    trigger: ONBOARDING_TEMPLATE.trigger,
    conditions: ONBOARDING_TEMPLATE.conditions,
    actions: ONBOARDING_TEMPLATE.actions,
  });
  await drain(); // flush events from setup
  return { ...ctx, managerUser, manager, wf };
}

async function tasksTitled(orgId: string, like: string) {
  return db()
    .select()
    .from(tasks)
    .where(and(eq(tasks.orgId, orgId), sql`${tasks.title} like ${like}`));
}

describe("workflow engine", () => {
  it("runs the onboarding workflow end to end", async () => {
    const { owner, org, as, manager, managerUser, wf } = await onboardingSetup();
    const hire = await as(owner).employees.create({
      firstName: "Nia",
      lastName: "New",
      email: email(),
      managerId: manager.id,
    });
    // Nothing happens until the worker runs: execution is asynchronous.
    expect(await tasksTitled(org.id, "%Nia%")).toHaveLength(0);
    await drain();

    const created = await tasksTitled(org.id, "%Nia%");
    expect(created.map((t) => t.title).sort()).toEqual([
      "Prepare equipment and accounts for Nia New",
      "Welcome meeting with Nia",
    ]);
    expect(created.find((t) => t.title.startsWith("Prepare"))?.assigneeEmployeeId).toBe(manager.id);
    expect(created.find((t) => t.title.startsWith("Welcome"))?.assigneeEmployeeId).toBe(hire.id);
    expect(created.every((t) => t.createdByUserId === owner.id)).toBe(true);

    const runs = await as(owner).workflows.runs({ workflowId: wf.id });
    expect(runs.items).toHaveLength(1);
    expect(runs.items[0]).toMatchObject({ status: "SUCCEEDED", attempts: 1, error: null });
    expect(runs.items[0]!.steps.map((s) => s.status)).toEqual(["SUCCEEDED", "SUCCEEDED", "SUCCEEDED"]);

    // Owner got the notify action; the manager got a normal task-assigned notification.
    expect(
      (await as(owner).notifications.list({})).items.some(
        (n) => n.title === "Onboarding started for Nia New",
      ),
    ).toBe(true);
    expect((await as(managerUser).notifications.list({})).items.some((n) => n.type === "TASK_ASSIGNED")).toBe(
      true,
    );
  });

  it("fails a run abandoned on its last attempt instead of retrying it forever", async () => {
    const { owner, org, as, manager } = await onboardingSetup();
    await as(owner).employees.create({
      firstName: "Abe",
      lastName: "Andoned",
      email: email(),
      managerId: manager.id,
    });
    await dispatchEvents(db());
    const [run] = await db()
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.orgId, org.id), eq(workflowRuns.status, "PENDING")));
    // Simulate a worker that crashed mid-run on the final attempt.
    await db()
      .update(workflowRuns)
      .set({ status: "RUNNING", attempts: run!.maxAttempts, lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(workflowRuns.id, run!.id));

    await runDueWorkflows(db());

    const [after] = await db().select().from(workflowRuns).where(eq(workflowRuns.id, run!.id));
    expect(after!.status).toBe("FAILED");
    expect(after!.attempts).toBe(run!.maxAttempts); // not re-claimed
    expect(after!.error).toMatch(/worker stopped/);
    expect((await as(owner).notifications.list({})).items.some((n) => n.type === "WORKFLOW_FAILED")).toBe(
      true,
    );
  });

  it("respects conditions", async () => {
    const { owner, org, as, wf } = await onboardingSetup();
    await as(owner).employees.create({
      firstName: "Lee",
      lastName: "Leave",
      email: email(),
      status: "ON_LEAVE",
    });
    await drain();
    expect(await tasksTitled(org.id, "%Lee%")).toHaveLength(0);
    expect((await as(owner).workflows.runs({ workflowId: wf.id })).total).toBe(0);
  });

  it("never runs a workflow twice for the same event, even with concurrent workers", async () => {
    const { owner, org, as, wf } = await onboardingSetup();
    await as(owner).employees.create({ firstName: "Con", lastName: "Current", email: email() });
    await Promise.all([dispatchEvents(db()), dispatchEvents(db()), dispatchEvents(db())]);
    await Promise.all([runDueWorkflows(db()), runDueWorkflows(db()), runDueWorkflows(db())]);
    await drain();
    expect(await tasksTitled(org.id, "%Con%")).toHaveLength(2);
    expect((await as(owner).workflows.runs({ workflowId: wf.id })).total).toBe(1);
  });

  it("marks permanent failures FAILED, notifies the owner, and never reports success", async () => {
    const { owner, org, as } = await createOrg();
    const gone = await as(owner).employees.create({ firstName: "Gone", lastName: "Soon", email: email() });
    const wf = await as(owner).workflows.create({
      name: "Broken assignee",
      trigger: "employee.created",
      conditions: [],
      actions: [
        {
          type: "create_task",
          title: "For {{firstName}}",
          description: "",
          priority: "LOW",
          dueInDays: null,
          assignee: "fixed_employee",
          employeeId: gone.id,
        },
      ],
    });
    await as(owner).employees.update({ id: gone.id, status: "TERMINATED" });
    await drain();
    await as(owner).employees.create({ firstName: "Trigger", lastName: "Person", email: email() });
    await drain();

    const runs = await as(owner).workflows.runs({ workflowId: wf.id });
    const run = runs.items.at(-1)!;
    expect(run.status).toBe("FAILED");
    expect(run.error).toMatch(/terminated/i);
    expect(run.steps).toEqual([expect.objectContaining({ status: "FAILED", stepIndex: 0 })]);
    expect(await tasksTitled(org.id, "For Trigger")).toHaveLength(0);
    const notes = await as(owner).notifications.list({});
    expect(notes.items.some((n) => n.type === "WORKFLOW_FAILED")).toBe(true);
    const log = await as(owner).audit.list({ entityType: "workflow" });
    expect(log.items.some((e) => e.action === "workflow.run_failed")).toBe(true);
  });

  it("retries resume after the last successful step without repeating side effects", async () => {
    const { owner, org, as } = await createOrg();
    const helper = await as(owner).employees.create({ firstName: "Help", lastName: "Er", email: email() });
    const wf = await as(owner).workflows.create({
      name: "Two steps",
      trigger: "employee.created",
      conditions: [{ field: "firstName", op: "eq", value: "Resume" }],
      actions: [
        {
          type: "create_task",
          title: "Step one for {{firstName}}",
          description: "",
          priority: "LOW",
          dueInDays: 1,
          assignee: "none",
          employeeId: null,
        },
        {
          type: "create_task",
          title: "Step two for {{firstName}}",
          description: "",
          priority: "LOW",
          dueInDays: null,
          assignee: "fixed_employee",
          employeeId: helper.id,
        },
      ],
    });
    await as(owner).employees.update({ id: helper.id, status: "TERMINATED" });
    await as(owner).employees.create({ firstName: "Resume", lastName: "Me", email: email() });
    await drain();
    let runs = await as(owner).workflows.runs({ workflowId: wf.id });
    expect(runs.items[0]!.status).toBe("FAILED");
    expect(await tasksTitled(org.id, "Step one%")).toHaveLength(1);

    await as(owner).employees.update({ id: helper.id, status: "ACTIVE" });
    await as(owner).workflows.retryRun({ runId: runs.items[0]!.id });
    await drain();
    runs = await as(owner).workflows.runs({ workflowId: wf.id });
    expect(runs.items[0]!.status).toBe("SUCCEEDED");
    expect(await tasksTitled(org.id, "Step one%")).toHaveLength(1); // not repeated
    expect(await tasksTitled(org.id, "Step two%")).toHaveLength(1);
    await expect(as(owner).workflows.retryRun({ runId: runs.items[0]!.id })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("backs off and retries transient failures, rolling back the failed step", async () => {
    const { owner, org, as, wf } = await onboardingSetup();
    await as(owner).employees.create({ firstName: "Flaky", lastName: "Net", email: email() });
    await dispatchEvents(db());
    let calls = 0;
    const flaky: typeof executeAction = async (tx, ctx, action) => {
      calls++;
      if (calls === 2) {
        await executeAction(tx, ctx, action); // side effect happens…
        throw new Error("connection reset"); // …then the step fails: it must roll back
      }
      return executeAction(tx, ctx, action);
    };
    expect(await runDueWorkflows(db(), 20, flaky)).toEqual(["RETRY"]);
    const [run] = await db().select().from(workflowRuns).where(eq(workflowRuns.workflowId, wf.id));
    expect(run).toMatchObject({
      status: "PENDING",
      attempts: 1,
      error: "Unexpected error while running this step. See server logs.",
    });
    expect(run!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(await tasksTitled(org.id, "Welcome meeting with Flaky")).toHaveLength(0); // rolled back

    // Make it due now and let the normal executor finish.
    await db().update(workflowRuns).set({ nextAttemptAt: new Date() }).where(eq(workflowRuns.id, run!.id));
    expect(await runDueWorkflows(db())).toEqual(["SUCCEEDED"]);
    expect(await tasksTitled(org.id, "%Flaky%")).toHaveLength(2);
    const steps = await db().select().from(workflowRunSteps).where(eq(workflowRunSteps.runId, run!.id));
    expect(
      steps
        .filter((s) => s.status === "SUCCEEDED")
        .map((s) => s.stepIndex)
        .sort(),
    ).toEqual([0, 1, 2]);
  });

  it("runs actions with the owner's current permissions — no escalation", async () => {
    const { owner, org, as } = await createOrg();
    const admin = await addMember(org.id, owner, "ADMIN", "Ada Admin");
    const wf = await as(admin).workflows.create({
      name: "Admin automation",
      trigger: "employee.created",
      conditions: [],
      actions: [
        {
          type: "create_task",
          title: "Auto {{firstName}}",
          description: "",
          priority: "LOW",
          dueInDays: null,
          assignee: "none",
          employeeId: null,
        },
      ],
    });
    const membership = (await as(owner).orgs.members()).find((m) => m.userId === admin.id)!;
    await as(owner).orgs.changeRole({ membershipId: membership.membershipId, role: "VIEWER" });
    await as(owner).employees.create({ firstName: "Esc", lastName: "Alate", email: email() });
    await drain();
    const run = (await as(owner).workflows.runs({ workflowId: wf.id })).items[0]!;
    expect(run.status).toBe("FAILED");
    expect(await tasksTitled(org.id, "Auto Esc")).toHaveLength(0);

    await as(owner).orgs.removeMember({ membershipId: membership.membershipId });
    await as(owner).employees.create({ firstName: "Gone", lastName: "Owner", email: email() });
    await drain();
    const runs = await as(owner).workflows.runs({ workflowId: wf.id });
    expect(runs.items[0]!.error).toMatch(/no longer a member/);
  });

  it("enforces workflow permissions and validation", async () => {
    const { owner, org, as } = await createOrg();
    const manager = await addMember(org.id, owner, "MANAGER");
    const member = await addMember(org.id, owner, "MEMBER");
    const def = {
      name: "x",
      trigger: "employee.created" as const,
      conditions: [],
      actions: ONBOARDING_TEMPLATE.actions,
    };
    await expect(as(manager).workflows.create(def)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(member).workflows.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(manager).workflows.list()).resolves.toEqual([]);
    await expect(
      as(owner).workflows.create({ ...def, conditions: [{ field: "nope", op: "eq", value: "x" }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      as(owner).workflows.create({ ...def, conditions: [{ field: "status", op: "eq", value: "FIRED" }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(as(owner).workflows.create({ ...def, actions: [] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      as(owner).workflows.create({
        ...def,
        actions: [{ type: "run_shell", cmd: "rm -rf /" } as unknown as WorkflowAction],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("isolates tenants: events, definitions, references and runs", async () => {
    const a = await onboardingSetup();
    const b = await createOrg();
    const bEmployee = await b
      .as(b.owner)
      .employees.create({ firstName: "B", lastName: "Emp", email: email() });
    // B creates employees; A's workflow must not fire.
    const before = (await a.as(a.owner).workflows.runs({ workflowId: a.wf.id })).total;
    await b.as(b.owner).employees.create({ firstName: "Other", lastName: "Tenant", email: email() });
    await drain();
    expect((await a.as(a.owner).workflows.runs({ workflowId: a.wf.id })).total).toBe(before);

    const B = b.as(b.owner);
    await expect(B.workflows.get({ id: a.wf.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(B.workflows.update({ id: a.wf.id, enabled: false })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(B.workflows.delete({ id: a.wf.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(B.workflows.runs({ workflowId: a.wf.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await a.as(a.owner).employees.create({ firstName: "Run", lastName: "A", email: email() });
    await drain();
    const aRun = (await a.as(a.owner).workflows.runs({ workflowId: a.wf.id })).items[0]!;
    await expect(B.workflows.retryRun({ runId: aRun.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A cannot point an action at B's employee.
    await expect(
      a.as(a.owner).workflows.create({
        name: "cross",
        trigger: "employee.created",
        conditions: [],
        actions: [
          {
            type: "create_task",
            title: "x",
            description: "",
            priority: "LOW",
            dueInDays: null,
            assignee: "fixed_employee",
            employeeId: bEmployee.id,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("does not dispatch events beyond the loop-guard depth", async () => {
    const { owner, org, as, wf } = await onboardingSetup();
    const user = await createUser();
    await db()
      .insert(domainEvents)
      .values({
        orgId: org.id,
        type: "employee.created",
        entityId: randomUUID(),
        actorUserId: user.id,
        payload: { firstName: "Deep", status: "ACTIVE", subjectEmployeeId: null, subjectUserId: null },
        depth: MAX_DEPTH,
      });
    await drain();
    expect((await as(owner).workflows.runs({ workflowId: wf.id })).total).toBe(0);
  });

  it("triggers on task status changes and approval decisions", async () => {
    const { owner, org, as } = await createOrg();
    const member = await addMember(org.id, owner, "MEMBER");
    await as(owner).workflows.create({
      name: "Blocked escalation",
      trigger: "task.status_changed",
      conditions: [{ field: "to", op: "eq", value: "BLOCKED" }],
      actions: [
        { type: "notify", title: "Blocked: {{title}}", body: "", recipient: "workflow_owner", userId: null },
      ],
    });
    await as(owner).workflows.create({
      name: "Approved purchase follow-up",
      trigger: "approval.decided",
      conditions: [
        { field: "decision", op: "eq", value: "APPROVED" },
        { field: "type", op: "eq", value: "PURCHASE" },
      ],
      actions: [
        {
          type: "create_task",
          title: "Place order: {{title}}",
          description: "",
          priority: "MEDIUM",
          dueInDays: 2,
          assignee: "subject_employee",
          employeeId: null,
        },
      ],
    });
    const t = await as(owner).tasks.create({ title: "Vendor contract" });
    await as(owner).tasks.update({ id: t.id, status: "BLOCKED" });
    const req = await as(member).approvals.create({
      type: "PURCHASE",
      title: "Standing desks",
      approverUserId: owner.id,
      payload: { amount: 1200, currency: "EUR", vendor: "DeskCo" },
    });
    await as(owner).approvals.decide({ id: req.id, decision: "APPROVED" });
    await drain();
    expect(
      (await as(owner).notifications.list({})).items.some((n) => n.title === "Blocked: Vendor contract"),
    ).toBe(true);
    expect(await tasksTitled(org.id, "Place order: Standing desks")).toHaveLength(1);
  });
});
