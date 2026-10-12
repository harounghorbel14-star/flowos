import { and, asc, eq, inArray } from "drizzle-orm";
import type { Database, Tx } from "../../db/client";
import type { aiRunStatusEnum, aiStepStatusEnum } from "../../db/schema";
import { aiRuns, aiRunSteps } from "../../db/schema";
import type { Actor } from "../../lib/actor";
import type { Evidence } from "./analysis";

/**
 * Persistence for runs and their steps. A step's status only ever reflects
 * what actually happened: SUCCEEDED after a result exists, AWAITING_CONFIRMATION
 * while a prepared change waits for the user, never ahead of the facts.
 */

export type RunStatus = (typeof aiRunStatusEnum.enumValues)[number];
export type StepStatus = (typeof aiStepStatusEnum.enumValues)[number];
export type StepRow = typeof aiRunSteps.$inferSelect;
export type RunRow = typeof aiRuns.$inferSelect;

export interface StepView {
  id: string;
  position: number;
  tool: string;
  purpose: string;
  status: StepStatus;
  planned: boolean;
  attempts: number;
  resultSummary: string | null;
  error: string | null;
  actionId: string | null;
  verified: boolean | null;
  latencyMs: number | null;
}

export const stepView = (s: StepRow): StepView => ({
  id: s.id,
  position: s.position,
  tool: s.tool,
  purpose: s.purpose,
  status: s.status,
  planned: s.planned,
  attempts: s.attempts,
  resultSummary: s.resultSummary,
  error: s.error,
  actionId: s.actionId,
  verified: s.verified,
  latencyMs: s.latencyMs,
});

export interface RunReport {
  status: RunStatus;
  objective: string;
  mode: "rules" | "model";
  model: string | null;
  counts: Record<"succeeded" | "failed" | "skipped" | "pending" | "cancelled", number>;
  steps: Array<{
    position: number;
    purpose: string;
    tool: string;
    status: StepStatus;
    summary: string | null;
    error: string | null;
    verified: boolean | null;
  }>;
  notes: string[];
  evidence: Evidence[];
  /** Model mode: whether the answer was based on at least one successful FLOWOS lookup. */
  grounded: boolean | null;
}

export async function createRun(
  db: Database,
  actor: Actor,
  conversationId: string,
  input: { mode: "rules" | "model"; model: string | null; intent: string | null; objective: string },
) {
  const [run] = await db
    .insert(aiRuns)
    .values({ orgId: actor.orgId, conversationId, userId: actor.userId, ...input })
    .returning();
  return run!;
}

export async function addSteps(
  db: Database,
  actor: Actor,
  runId: string,
  from: number,
  steps: Array<{ tool: string; purpose: string; input: Record<string, unknown>; planned: boolean }>,
): Promise<StepRow[]> {
  if (steps.length === 0) return [];
  return db
    .insert(aiRunSteps)
    .values(steps.map((s, i) => ({ orgId: actor.orgId, runId, position: from + i, ...s })))
    .returning();
}

export async function updateStep(
  db: Database | Tx,
  stepId: string,
  patch: Partial<Omit<StepRow, "id" | "orgId" | "runId" | "position">>,
): Promise<StepRow> {
  const [row] = await db.update(aiRunSteps).set(patch).where(eq(aiRunSteps.id, stepId)).returning();
  return row!;
}

export async function stepsOf(db: Database | Tx, runId: string) {
  return db.select().from(aiRunSteps).where(eq(aiRunSteps.runId, runId)).orderBy(asc(aiRunSteps.position));
}

/** Marks a planned step that a revised plan replaced before it started: not a failure. */
export const SUPERSEDED = "Replaced by a revised plan.";

/**
 * Run status from its steps. A skipped step (unresolvable input, rejected by the user, never run)
 * means the objective was not fully achieved, like a failure; a superseded step does not count.
 */
export function deriveStatus(steps: Pick<StepRow, "status" | "error">[], forced?: RunStatus): RunStatus {
  if (forced) return forced;
  const relevant = steps.filter((x) => !(x.status === "SKIPPED" && x.error === SUPERSEDED));
  const has = (s: StepStatus) => relevant.some((x) => x.status === s);
  if (has("AWAITING_CONFIRMATION")) return "AWAITING_CONFIRMATION";
  if (has("FAILED") || has("SKIPPED") || has("CANCELLED")) return has("SUCCEEDED") ? "PARTIAL" : "FAILED";
  return "COMPLETED";
}

export function buildReport(
  run: Pick<RunRow, "objective" | "mode" | "model">,
  steps: StepRow[],
  status: RunStatus,
  extra: { notes: string[]; evidence: Evidence[]; grounded: boolean | null },
): RunReport {
  const count = (s: StepStatus[]) => steps.filter((x) => s.includes(x.status)).length;
  return {
    status,
    objective: run.objective,
    mode: run.mode,
    model: run.model,
    counts: {
      succeeded: count(["SUCCEEDED"]),
      failed: count(["FAILED"]),
      skipped: count(["SKIPPED"]),
      pending: count(["PENDING", "RUNNING", "AWAITING_CONFIRMATION"]),
      cancelled: count(["CANCELLED"]),
    },
    steps: steps.map((s) => ({
      position: s.position,
      purpose: s.purpose,
      tool: s.tool,
      status: s.status,
      summary: s.resultSummary,
      error: s.error,
      verified: s.verified,
    })),
    notes: extra.notes,
    evidence: extra.evidence.slice(0, 25),
    grounded: extra.grounded,
  };
}

const STATUS_WORD: Record<RunStatus, string> = {
  RUNNING: "running",
  COMPLETED: "completed",
  PARTIAL: "partly completed",
  AWAITING_CONFIRMATION: "waiting for confirmation",
  FAILED: "failed",
  CANCELLED: "stopped",
};

/** A deterministic one-line record of the run, built from step results (never from model text). */
export function runSummary(objective: string, status: RunStatus, steps: StepRow[]) {
  const done = steps
    .filter((s) => s.status === "SUCCEEDED" && s.verified)
    .map((s) => s.resultSummary)
    .filter(Boolean);
  return `${objective} — ${STATUS_WORD[status]}${done.length ? `; verified: ${done.join("; ")}` : ""}`.slice(
    0,
    500,
  );
}

/** Close a run (or refresh it after a confirmation changed a step): status, report and summary from its steps. */
export async function settleRun(
  db: Database | Tx,
  runId: string,
  opts: {
    forced?: RunStatus;
    error?: string | null;
    extra?: Partial<Pick<RunReport, "notes" | "evidence" | "grounded">>;
  } = {},
) {
  const [run] = await db.select().from(aiRuns).where(eq(aiRuns.id, runId));
  if (!run) return null;
  const steps = await stepsOf(db, runId);
  const previous = (run.report ?? {}) as Partial<RunReport>;
  const status = deriveStatus(steps, opts.forced);
  const report = buildReport(run, steps, status, {
    notes: opts.extra?.notes ?? previous.notes ?? [],
    evidence: opts.extra?.evidence ?? previous.evidence ?? [],
    grounded: opts.extra?.grounded ?? previous.grounded ?? null,
  });
  const finishedAt = run.finishedAt ?? new Date();
  const [updated] = await db
    .update(aiRuns)
    .set({
      status,
      report: report as unknown as Record<string, unknown>,
      summary: runSummary(run.objective, status, steps),
      error: opts.error === undefined ? run.error : opts.error,
      finishedAt,
      latencyMs: run.latencyMs ?? finishedAt.getTime() - run.startedAt.getTime(),
    })
    .where(eq(aiRuns.id, runId))
    .returning();
  return { run: updated!, report };
}

/** Runs of a conversation with their steps, for the transcript view. */
export async function runsOfConversation(db: Database, actor: Actor, conversationId: string) {
  const runs = await db
    .select()
    .from(aiRuns)
    .where(and(eq(aiRuns.orgId, actor.orgId), eq(aiRuns.conversationId, conversationId)))
    .orderBy(asc(aiRuns.startedAt));
  const steps = runs.length
    ? await db
        .select()
        .from(aiRunSteps)
        .where(
          and(
            eq(aiRunSteps.orgId, actor.orgId),
            inArray(
              aiRunSteps.runId,
              runs.map((r) => r.id),
            ),
          ),
        )
        .orderBy(asc(aiRunSteps.position))
    : [];
  return runs.map((r) => ({
    id: r.id,
    mode: r.mode,
    model: r.model,
    intent: r.intent,
    objective: r.objective,
    status: r.status,
    error: r.error,
    report: r.report as RunReport | null,
    startedAt: r.startedAt,
    latencyMs: r.latencyMs,
    modelRequests: r.modelRequests,
    steps: steps.filter((s) => s.runId === r.id).map(stepView),
  }));
}
