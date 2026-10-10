import { and, asc, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { TRIGGERS, type Condition, type TriggerType, type WorkflowAction } from "@shared/workflows";
import type { Database, Tx } from "../../db/client";
import { domainEvents, users, workflowRuns, workflowRunSteps, workflows } from "../../db/schema";
import { assertCan, type Actor } from "../../lib/actor";
import { audit } from "../../lib/audit";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { offsetOf, toPage, type PageInput } from "../../lib/pagination";
import { requireEmployee, requireMember } from "../../lib/refs";
import { assertWithinLimit } from "../billing/entitlements";
import { integrationById } from "@shared/integrations";
import { integrationConnections } from "../../db/schema";

export interface WorkflowInput {
  name: string;
  description?: string | null;
  enabled?: boolean;
  trigger: TriggerType;
  conditions: Condition[];
  actions: WorkflowAction[];
}

/** Validate conditions against the trigger's fields and every ID against the tenant. */
async function validate(tx: Tx, actor: Actor, input: WorkflowInput) {
  const def = TRIGGERS[input.trigger];
  if (!def) throw badRequest("Unknown trigger.");
  const fields = new Map<string, readonly string[] | undefined>(
    def.fields.map((f) => [f.key, "values" in f ? (f.values as readonly string[]) : undefined]),
  );
  for (const c of input.conditions) {
    if (!fields.has(c.field)) throw badRequest(`“${c.field}” is not available for this trigger.`);
    const allowed = fields.get(c.field);
    if (allowed && (c.op === "eq" || c.op === "neq") && !allowed.includes(c.value)) {
      throw badRequest(`“${c.value}” is not a valid value for ${c.field}.`);
    }
  }
  if (input.actions.length === 0) throw badRequest("Add at least one action.");
  for (const a of input.actions) {
    if (a.type === "create_task" && a.assignee === "fixed_employee") {
      if (!a.employeeId) throw badRequest("Choose the employee to assign the task to.");
      await requireEmployee(tx, actor.orgId, a.employeeId, "Assignee");
    }
    if (a.type === "notify" && a.recipient === "fixed_user") {
      if (!a.userId) throw badRequest("Choose the member to notify.");
      await requireMember(tx, actor.orgId, a.userId);
    }
    if (a.type === "send_message") {
      const [conn] = await tx
        .select({ id: integrationConnections.id })
        .from(integrationConnections)
        .where(
          and(eq(integrationConnections.orgId, actor.orgId), eq(integrationConnections.provider, a.provider)),
        );
      if (!conn)
        throw badRequest(`Connect ${integrationById(a.provider)!.name} in Settings → Integrations first.`);
    }
  }
}

export async function listWorkflows(db: Database, actor: Actor) {
  assertCan(actor, "workflow:read");
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const rows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      description: workflows.description,
      enabled: workflows.enabled,
      trigger: workflows.trigger,
      actionCount: sql<number>`jsonb_array_length(${workflows.actions})`.mapWith(Number),
      ownerName: users.name,
      updatedAt: workflows.updatedAt,
    })
    .from(workflows)
    .leftJoin(users, eq(users.id, workflows.ownerUserId))
    .where(eq(workflows.orgId, actor.orgId))
    .orderBy(asc(workflows.name));
  const stats = await db
    .select({
      workflowId: workflowRuns.workflowId,
      succeeded: sql<number>`count(*) filter (where ${workflowRuns.status} = 'SUCCEEDED')`.mapWith(Number),
      failed: sql<number>`count(*) filter (where ${workflowRuns.status} = 'FAILED')`.mapWith(Number),
      inFlight: sql<number>`count(*) filter (where ${workflowRuns.status} in ('PENDING','RUNNING'))`.mapWith(
        Number,
      ),
      lastRunAt: sql<Date | null>`max(${workflowRuns.createdAt})`,
    })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.orgId, actor.orgId), gte(workflowRuns.createdAt, since)))
    .groupBy(workflowRuns.workflowId);
  const byId = new Map(stats.map((s) => [s.workflowId, s]));
  return rows.map((r) => ({
    ...r,
    last7Days: byId.get(r.id) ?? { succeeded: 0, failed: 0, inFlight: 0, lastRunAt: null },
  }));
}

export async function getWorkflow(db: Database, actor: Actor, id: string) {
  assertCan(actor, "workflow:read");
  const [wf] = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      description: workflows.description,
      enabled: workflows.enabled,
      trigger: workflows.trigger,
      conditions: workflows.conditions,
      actions: workflows.actions,
      ownerUserId: workflows.ownerUserId,
      ownerName: users.name,
      createdAt: workflows.createdAt,
      updatedAt: workflows.updatedAt,
    })
    .from(workflows)
    .leftJoin(users, eq(users.id, workflows.ownerUserId))
    .where(and(eq(workflows.orgId, actor.orgId), eq(workflows.id, id)));
  if (!wf) throw notFound("Workflow");
  return wf;
}

export async function createWorkflow(db: Database, actor: Actor, input: WorkflowInput) {
  assertCan(actor, "workflow:manage");
  return db.transaction(async (tx) => {
    await validate(tx, actor, input);
    await assertWithinLimit(tx, actor.orgId, "workflows");
    const [wf] = await tx
      .insert(workflows)
      .values({ ...input, orgId: actor.orgId, ownerUserId: actor.userId })
      .returning();
    await audit(tx, actor, {
      action: "workflow.created",
      entityType: "workflow",
      entityId: wf!.id,
      summary: `Created workflow “${wf!.name}”`,
      metadata: { trigger: input.trigger, actions: input.actions.map((a) => a.type) },
    });
    return wf!;
  });
}

/**
 * Saving a workflow makes the saver its owner: actions run with the
 * permissions of whoever last approved the definition.
 */
export async function updateWorkflow(db: Database, actor: Actor, id: string, input: Partial<WorkflowInput>) {
  assertCan(actor, "workflow:manage");
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(workflows)
      .where(and(eq(workflows.orgId, actor.orgId), eq(workflows.id, id)))
      .for("update");
    if (!before) throw notFound("Workflow");
    const merged: WorkflowInput = {
      name: input.name ?? before.name,
      description: input.description !== undefined ? input.description : before.description,
      enabled: input.enabled ?? before.enabled,
      trigger: input.trigger ?? before.trigger,
      conditions: input.conditions ?? before.conditions,
      actions: input.actions ?? before.actions,
    };
    await validate(tx, actor, merged);
    const [after] = await tx
      .update(workflows)
      .set({ ...merged, ownerUserId: actor.userId, updatedAt: new Date() })
      .where(and(eq(workflows.orgId, actor.orgId), eq(workflows.id, id)))
      .returning();
    const onlyToggle = Object.keys(input).length === 1 && input.enabled !== undefined;
    await audit(tx, actor, {
      action: onlyToggle ? (input.enabled ? "workflow.enabled" : "workflow.disabled") : "workflow.updated",
      entityType: "workflow",
      entityId: id,
      summary: onlyToggle
        ? `${input.enabled ? "Enabled" : "Disabled"} workflow “${after!.name}”`
        : `Updated workflow “${after!.name}”`,
    });
    return after!;
  });
}

export async function deleteWorkflow(db: Database, actor: Actor, id: string) {
  assertCan(actor, "workflow:manage");
  return db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(workflows)
      .where(and(eq(workflows.orgId, actor.orgId), eq(workflows.id, id)))
      .returning({ name: workflows.name });
    if (!deleted) throw notFound("Workflow");
    await audit(tx, actor, {
      action: "workflow.deleted",
      entityType: "workflow",
      entityId: id,
      summary: `Deleted workflow “${deleted.name}”`,
    });
    return { ok: true };
  });
}

export async function listRuns(db: Database, actor: Actor, workflowId: string, input: PageInput) {
  assertCan(actor, "workflow:read");
  await getWorkflow(db, actor, workflowId);
  const where = and(eq(workflowRuns.orgId, actor.orgId), eq(workflowRuns.workflowId, workflowId));
  const [runs, [total]] = await Promise.all([
    db
      .select({
        id: workflowRuns.id,
        status: workflowRuns.status,
        attempts: workflowRuns.attempts,
        maxAttempts: workflowRuns.maxAttempts,
        error: workflowRuns.error,
        nextAttemptAt: workflowRuns.nextAttemptAt,
        createdAt: workflowRuns.createdAt,
        finishedAt: workflowRuns.finishedAt,
        eventId: workflowRuns.eventId,
        eventPayload: domainEvents.payload,
      })
      .from(workflowRuns)
      .innerJoin(domainEvents, eq(domainEvents.id, workflowRuns.eventId))
      .where(where)
      .orderBy(desc(workflowRuns.createdAt))
      .limit(input.pageSize)
      .offset(offsetOf(input)),
    db.select({ n: count() }).from(workflowRuns).where(where),
  ]);
  const steps = runs.length
    ? await db
        .select({
          runId: workflowRunSteps.runId,
          stepIndex: workflowRunSteps.stepIndex,
          actionType: workflowRunSteps.actionType,
          status: workflowRunSteps.status,
          attempt: workflowRunSteps.attempt,
          output: workflowRunSteps.output,
          error: workflowRunSteps.error,
          createdAt: workflowRunSteps.createdAt,
        })
        .from(workflowRunSteps)
        .where(
          and(
            eq(workflowRunSteps.orgId, actor.orgId),
            inArray(
              workflowRunSteps.runId,
              runs.map((r) => r.id),
            ),
          ),
        )
        .orderBy(asc(workflowRunSteps.stepIndex), asc(workflowRunSteps.createdAt))
    : [];
  const items = runs.map(({ eventPayload, ...r }) => ({
    ...r,
    triggeredBy: describeEvent(eventPayload),
    steps: steps.filter((s) => s.runId === r.id),
  }));
  return toPage(items, total?.n ?? 0, input);
}

/** One-line description of what triggered a run; only uses fields the trigger exposes. */
function describeEvent(payload: Record<string, unknown>): string {
  if (typeof payload.title === "string") return payload.title;
  const name = [payload.firstName, payload.lastName].filter((p) => typeof p === "string" && p).join(" ");
  return name || "Event";
}

/** Re-queue a failed run. Steps that already succeeded are not repeated. */
export async function retryRun(db: Database, actor: Actor, runId: string) {
  assertCan(actor, "workflow:manage");
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.orgId, actor.orgId), eq(workflowRuns.id, runId)))
      .for("update");
    if (!run) throw notFound("Run");
    if (run.status !== "FAILED") throw conflict("Only failed runs can be retried.");
    await tx
      .update(workflowRuns)
      .set({
        status: "PENDING",
        maxAttempts: run.attempts + 3,
        nextAttemptAt: new Date(),
        finishedAt: null,
        error: null,
      })
      .where(eq(workflowRuns.id, runId));
    await audit(tx, actor, {
      action: "workflow.run_retried",
      entityType: "workflow",
      entityId: run.workflowId,
      summary: "Retried a failed workflow run",
      metadata: { runId },
    });
    return { ok: true };
  });
}

export async function failureCount(db: Database, actor: Actor, days = 7) {
  const [row] = await db
    .select({ n: count() })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.orgId, actor.orgId),
        eq(workflowRuns.status, "FAILED"),
        gte(workflowRuns.createdAt, new Date(Date.now() - days * 24 * 3600 * 1000)),
      ),
    );
  return row?.n ?? 0;
}
