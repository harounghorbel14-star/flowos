import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import type { Role } from "@shared/domain";
import { evaluateCondition } from "@shared/workflows";
import type { Database } from "../../db/client";
import { domainEvents, memberships, workflowRuns, workflowRunSteps, workflows } from "../../db/schema";
import type { Actor } from "../../lib/actor";
import { audit } from "../../lib/audit";
import { AppError } from "../../lib/errors";
import { purgeExpiredRateLimits } from "../../auth/rateLimit";
import { purgeExpiredSessions } from "../../auth/session";
import { notifyExpiringDocuments } from "../documents/service";
import { recordDailySnapshots } from "../insights/service";
import { purgeOldWebhookEvents } from "../billing/service";
import { notify } from "../notifications/service";
import { describeError, executeAction, PermanentError } from "./actions";
import { logSafeError } from "../../lib/logging";

/** Events produced this many workflow hops deep are recorded but never dispatched (loop guard). */
export const MAX_DEPTH = 3;
const LOCK_MS = 5 * 60 * 1000;
const BASE_BACKOFF_MS = 30 * 1000;

/**
 * Turn committed outbox events into workflow runs. Runs inside one
 * transaction with SKIP LOCKED, so concurrent dispatchers never double-claim,
 * and the (workflow_id, event_id) unique key makes it idempotent anyway.
 */
export async function dispatchEvents(db: Database, limit = 100): Promise<number> {
  return db.transaction(async (tx) => {
    const events = await tx
      .select()
      .from(domainEvents)
      .where(isNull(domainEvents.dispatchedAt))
      .orderBy(asc(domainEvents.id))
      .limit(limit)
      .for("update", { skipLocked: true });
    let created = 0;
    for (const event of events) {
      if (event.depth < MAX_DEPTH) {
        const candidates = await tx
          .select()
          .from(workflows)
          .where(
            and(
              eq(workflows.orgId, event.orgId),
              eq(workflows.trigger, event.type as never),
              eq(workflows.enabled, true),
              // Only workflows that already existed when the event happened.
              lte(workflows.createdAt, event.createdAt),
            ),
          );
        for (const wf of candidates) {
          if (!wf.conditions.every((c) => evaluateCondition(c, event.payload))) continue;
          const inserted = await tx
            .insert(workflowRuns)
            .values({ orgId: event.orgId, workflowId: wf.id, eventId: event.id, actions: wf.actions })
            .onConflictDoNothing()
            .returning({ id: workflowRuns.id });
          created += inserted.length;
        }
      }
      await tx.update(domainEvents).set({ dispatchedAt: new Date() }).where(eq(domainEvents.id, event.id));
    }
    return created;
  });
}

/** Claim due runs (or runs whose worker died mid-flight) for execution. */
async function claimRuns(db: Database, limit: number) {
  const result = await db.execute<{ id: string }>(sql`
    update ${workflowRuns}
       set status = 'RUNNING',
           attempts = attempts + 1,
           locked_until = now() + ${`${LOCK_MS} milliseconds`}::interval,
           started_at = coalesce(started_at, now())
     where id in (
       select id from ${workflowRuns}
        where (status = 'PENDING' and next_attempt_at <= now())
           or (status = 'RUNNING' and locked_until < now() and attempts < max_attempts)
        order by next_attempt_at
        limit ${limit}
        for update skip locked)
    returning id`);
  return result.rows.map((r) => r.id);
}

async function resolveOwner(
  db: Database,
  orgId: string,
  ownerUserId: string | null,
  depth: number,
): Promise<Actor> {
  if (!ownerUserId) throw new PermanentError("This workflow has no owner. Ask an admin to re-save it.");
  const [m] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, ownerUserId)));
  if (!m)
    throw new PermanentError("The workflow owner is no longer a member, so it cannot act on their behalf.");
  return { userId: ownerUserId, orgId, role: m.role as Role, ip: null, workflowDepth: depth + 1 };
}

const isPermanent = (err: unknown) =>
  err instanceof PermanentError || (err instanceof AppError && err.code !== "TOO_MANY_REQUESTS");

/** Execute one claimed run. Never reports success unless every step succeeded. */
export async function executeRun(
  db: Database,
  runId: string,
  exec: typeof executeAction = executeAction,
): Promise<"SUCCEEDED" | "FAILED" | "RETRY"> {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
  if (!run) return "FAILED";
  const [wf] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.orgId, run.orgId), eq(workflows.id, run.workflowId)));
  const [event] = await db.select().from(domainEvents).where(eq(domainEvents.id, run.eventId));

  let failedStep: number | null = null;
  try {
    if (!wf || !event) throw new PermanentError("The workflow or its triggering event no longer exists.");
    const actor = await resolveOwner(db, run.orgId, wf.ownerUserId, event.depth);
    const done = new Set(
      (
        await db
          .select({ stepIndex: workflowRunSteps.stepIndex })
          .from(workflowRunSteps)
          .where(and(eq(workflowRunSteps.runId, run.id), eq(workflowRunSteps.status, "SUCCEEDED")))
      ).map((s) => s.stepIndex),
    );
    for (const [index, action] of run.actions.entries()) {
      if (done.has(index)) continue; // already applied on an earlier attempt
      failedStep = index;
      // The side effect and its step record commit together: a step is applied exactly once.
      await db.transaction(async (tx) => {
        const output = await exec(
          tx,
          { actor, payload: event.payload, ownerUserId: wf.ownerUserId! },
          action,
        );
        await tx.insert(workflowRunSteps).values({
          orgId: run.orgId,
          runId: run.id,
          stepIndex: index,
          actionType: action.type,
          status: "SUCCEEDED",
          attempt: run.attempts,
          output,
        });
      });
      failedStep = null;
    }
    await db
      .update(workflowRuns)
      .set({ status: "SUCCEEDED", finishedAt: new Date(), lockedUntil: null, error: null })
      .where(eq(workflowRuns.id, run.id));
    return "SUCCEEDED";
  } catch (err) {
    if (!(err instanceof PermanentError) && !(err instanceof AppError))
      console.error("[workflows] run failed:", logSafeError(err));
    const message = describeError(err);
    if (failedStep !== null) {
      await db.insert(workflowRunSteps).values({
        orgId: run.orgId,
        runId: run.id,
        stepIndex: failedStep,
        actionType: run.actions[failedStep]?.type ?? "unknown",
        status: "FAILED",
        attempt: run.attempts,
        error: message,
      });
    }
    const final = isPermanent(err) || run.attempts >= run.maxAttempts;
    if (!final) {
      const delay = BASE_BACKOFF_MS * 2 ** (run.attempts - 1);
      await db
        .update(workflowRuns)
        .set({
          status: "PENDING",
          error: message,
          lockedUntil: null,
          nextAttemptAt: new Date(Date.now() + delay),
        })
        .where(eq(workflowRuns.id, run.id));
      return "RETRY";
    }
    await finalizeFailure(db, run, wf, message);
    return "FAILED";
  }
}

type RunRow = typeof workflowRuns.$inferSelect;
type WorkflowRow = typeof workflows.$inferSelect;

/** Mark a run FAILED for good: audited, and the workflow owner is notified. */
async function finalizeFailure(db: Database, run: RunRow, wf: WorkflowRow | undefined, message: string) {
  await db.transaction(async (tx) => {
    await tx
      .update(workflowRuns)
      .set({ status: "FAILED", error: message, lockedUntil: null, finishedAt: new Date() })
      .where(eq(workflowRuns.id, run.id));
    await audit(
      tx,
      { userId: null, orgId: run.orgId },
      {
        action: "workflow.run_failed",
        entityType: "workflow",
        entityId: run.workflowId,
        summary: `Workflow “${wf?.name ?? "deleted workflow"}” failed: ${message}`,
        metadata: { runId: run.id, attempts: run.attempts },
      },
    );
    if (wf?.ownerUserId) {
      await notify(tx, {
        orgId: run.orgId,
        userId: wf.ownerUserId,
        actorUserId: null,
        type: "WORKFLOW_FAILED",
        title: `Workflow “${wf.name}” failed`,
        body: message,
        link: `/workflows/${wf.id}`,
      });
    }
  });
}

/**
 * Runs whose worker died mid-flight on their last allowed attempt (process
 * crash, OOM, deploy kill) are never re-claimed; fail them instead of leaving
 * them RUNNING forever, so the owner hears about it.
 */
export async function failAbandonedRuns(db: Database, limit = 20) {
  const claimed = await db.execute<{ id: string }>(sql`
    update ${workflowRuns}
       set locked_until = now() + ${`${LOCK_MS} milliseconds`}::interval
     where id in (
       select id from ${workflowRuns}
        where status = 'RUNNING' and locked_until < now() and attempts >= max_attempts
        limit ${limit}
        for update skip locked)
    returning id`);
  for (const { id } of claimed.rows) {
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id));
    if (!run) continue;
    const [wf] = await db
      .select()
      .from(workflows)
      .where(and(eq(workflows.orgId, run.orgId), eq(workflows.id, run.workflowId)));
    await finalizeFailure(
      db,
      run,
      wf,
      `The worker stopped while running this workflow on its last attempt (${run.attempts} of ${run.maxAttempts}).`,
    );
  }
  return claimed.rows.length;
}

export async function runDueWorkflows(db: Database, limit = 20, exec: typeof executeAction = executeAction) {
  await failAbandonedRuns(db);
  const ids = await claimRuns(db, limit);
  const results = [];
  for (const id of ids) results.push(await executeRun(db, id, exec));
  return results;
}

/** One workflow tick: dispatch new events and run what is due. */
export async function runWorkerOnce(db: Database) {
  const dispatched = await dispatchEvents(db);
  const results = await runDueWorkflows(db);
  return { dispatched, results };
}

/** Periodic maintenance across all tenants; cheap but not needed every tick. */
export async function runHousekeeping(db: Database) {
  const expiryReminders = await notifyExpiringDocuments(db);
  const rateLimitsPurged = await purgeExpiredRateLimits(db);
  const sessionsPurged = await purgeExpiredSessions(db);
  const webhookEventsPurged = await purgeOldWebhookEvents(db);
  return { expiryReminders, rateLimitsPurged, sessionsPurged, webhookEventsPurged };
}

/**
 * In-process background worker. Ticks never overlap. After a failed tick
 * (e.g. the database is down) the next ones are delayed exponentially, up to
 * a minute, so an outage does not flood the logs. Housekeeping runs about
 * once a minute; daily metric snapshots are refreshed hourly. The returned function stops scheduling new ticks and
 * resolves once the tick in progress (if any) has finished, so shutdown
 * never cuts a step's transaction short.
 */
export function startWorker(
  db: Database,
  intervalMs = 2000,
  housekeepingMs = 60_000,
  snapshotMs = 60 * 60_000,
): () => Promise<void> {
  let current: Promise<void> | null = null;
  let failures = 0;
  let nextTickAt = 0;
  let nextHousekeepingAt = 0;
  let nextSnapshotAt = 0;
  const tick = async () => {
    await runWorkerOnce(db);
    if (Date.now() >= nextHousekeepingAt) {
      await runHousekeeping(db);
      nextHousekeepingAt = Date.now() + housekeepingMs;
    }
    if (Date.now() >= nextSnapshotAt) {
      await recordDailySnapshots(db);
      nextSnapshotAt = Date.now() + snapshotMs;
    }
  };
  const timer = setInterval(() => {
    if (current || Date.now() < nextTickAt) return;
    current = tick()
      .then(() => {
        if (failures > 0) console.log(`[workflows] worker recovered after ${failures} failed tick(s)`);
        failures = 0;
      })
      .catch((err: unknown) => {
        failures++;
        nextTickAt = Date.now() + Math.min(60_000, intervalMs * 2 ** failures);
        console.error(`[workflows] worker tick failed (${failures} in a row):`, logSafeError(err));
      })
      .finally(() => {
        current = null;
      });
  }, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await current;
  };
}
