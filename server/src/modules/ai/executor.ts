import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database } from "../../db/client";
import { aiActions, aiToolCalls } from "../../db/schema";
import type { Actor } from "../../lib/actor";
import { audit } from "../../lib/audit";
import { AppError } from "../../lib/errors";
import { logSafeError } from "../../lib/logging";
import type { Emit } from "./events";
import { addMemory } from "./memory";
import { decide, isTransient, LIMITS } from "./policy";
import { stepView, updateStep, type StepRow } from "./runs";
import { findTool, type ToolDef } from "./tools";

/**
 * TaskExecutor: runs one plan step against a registered tool. Policy first,
 * then input validation, then execution with a timeout. Reads that fail for a
 * transient reason are retried a bounded number of times; writes never are.
 */

const TOOL_RESULT_LIMIT = 20_000;

/** Engine-internal tools: never offered to a model; reachable only from explicit rules-mode commands. */
const INTERNAL_TOOLS: ToolDef[] = [
  {
    name: "save_preference",
    description: "Save a preference the user stated explicitly.",
    schema: z.object({ content: z.string().trim().min(2).max(500) }),
    inputSchema: {},
    permissions: ["ai:use"],
    risk: "low",
    execute: async (db, actor, input: { content: string }) => {
      const row = await addMemory(db as Database, actor, { scope: "PREFERENCE", content: input.content });
      return { memoryId: row.id, content: row.content };
    },
    summarize: () => "Preference saved",
    verify: async (_db, _actor, input: { content: string }, result) => ({
      verified: (result as { content: string }).content.length > 0,
      detail: `Saved: “${input.content.slice(0, 80)}”`,
    }),
  } as ToolDef,
];

export function resolveTool(name: string, allowInternal: boolean): ToolDef | undefined {
  return findTool(name) ?? (allowInternal ? INTERNAL_TOOLS.find((t) => t.name === name) : undefined);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashInput(toolName: string, input: unknown): string {
  return createHash("sha256")
    .update(`${toolName}\n${canonical(input)}`)
    .digest("hex");
}

export class StepTimeoutError extends Error {
  override readonly name = "StepTimeoutError";
}

function withTimeout<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new StepTimeoutError(`The step took longer than ${ms / 1000}s.`)),
      ms,
    );
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export interface RunContext {
  db: Database;
  actor: Actor;
  conversationId: string;
  runId: string;
  emit: Emit;
  signal?: AbortSignal;
  /** Counted across the run for the policy limits and loop detection. */
  counters: { steps: number; writes: number; calls: Map<string, number> };
  /** Rules-mode commands may use internal tools; a model never can. */
  allowInternal: boolean;
  /** Tool-call id to tie a prepared action to (model mode); generated otherwise. */
  callId?: string;
}

export interface StepOutcome {
  status: StepRow["status"];
  output?: unknown;
  summary?: string;
  error?: string;
  /** What a model is told about this step. */
  forModel: string;
  isError: boolean;
  actionId?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function executeStep(ctx: RunContext, step: StepRow, rawInput: unknown): Promise<StepOutcome> {
  const { db, actor, emit } = ctx;
  const started = Date.now();
  const tool = resolveTool(step.tool, ctx.allowInternal);
  const callId = ctx.callId ?? `rules_${step.id}`;

  const finish = async (o: StepOutcome, logOutcome: "OK" | "ERROR" | "DENIED" | "INVALID" | "PROPOSED") => {
    const row = await updateStep(db, step.id, {
      status: o.status,
      resultSummary: o.summary ?? null,
      error: o.error ?? null,
      result: o.output === undefined ? null : compact(o.output),
      actionId: o.actionId ?? null,
      finishedAt: o.status === "AWAITING_CONFIRMATION" ? null : new Date(),
      latencyMs: Date.now() - started,
    });
    await db.insert(aiToolCalls).values({
      orgId: actor.orgId,
      conversationId: ctx.conversationId,
      userId: actor.userId,
      toolUseId: callId,
      toolName: step.tool,
      outcome: logOutcome,
      error: o.error ?? null,
      latencyMs: Date.now() - started,
    });
    emit({ type: "tool", name: step.tool, outcome: logOutcome });
    emit({ type: "step", step: stepView(row) });
    return o;
  };

  if (ctx.signal?.aborted) {
    const row = await updateStep(db, step.id, { status: "CANCELLED", error: "Stopped before it ran." });
    emit({ type: "step", step: stepView(row) });
    return { status: "CANCELLED", error: "Stopped", forModel: "Cancelled.", isError: true };
  }

  // Loop prevention: the same call with the same input more than twice in one run is refused.
  const key = hashInput(step.tool, rawInput ?? {});
  const seen = (ctx.counters.calls.get(key) ?? 0) + 1;
  ctx.counters.calls.set(key, seen);
  const decision =
    seen > 2
      ? ({ kind: "deny", reason: "The same call was already made twice in this request." } as const)
      : decide(actor, tool, ctx.counters);
  ctx.counters.steps++;
  if (decision.kind === "deny") {
    return finish(
      { status: "FAILED", error: decision.reason, forModel: decision.reason, isError: true },
      "DENIED",
    );
  }
  const parsed = tool!.schema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return finish(
      {
        status: "FAILED",
        error: `Invalid input: ${message}`,
        forModel: `Invalid input: ${message}`,
        isError: true,
      },
      "INVALID",
    );
  }
  const input = parsed.data as Record<string, unknown>;
  await updateStep(db, step.id, { status: "RUNNING", input, startedAt: new Date() }).then((row) =>
    emit({ type: "step", step: stepView(row) }),
  );

  if (decision.kind === "confirm") {
    const prepared = await prepare(ctx, step, tool!, input, callId);
    return finish(prepared, prepared.status === "AWAITING_CONFIRMATION" ? "PROPOSED" : "INVALID");
  }

  if (decision.kind === "auto") {
    ctx.counters.writes++;
    try {
      // No timeout here: abandoning a write that may still commit would misreport its outcome.
      const output = await db.transaction(async (tx) => {
        const out = await tool!.execute(tx, actor, input);
        await audit(tx, actor, {
          action: tool!.auditAction ?? "ai.action_executed",
          entityType: "ai_run",
          entityId: ctx.runId,
          summary: `Assistant (automatic, low risk): ${tool!.summarize?.(out, input) ?? tool!.name}`,
          metadata: { toolName: tool!.name, conversationId: ctx.conversationId },
        });
        return out;
      });
      const check = tool!.verify ? await tool!.verify(db, actor, input, output) : null;
      await updateStep(db, step.id, { verified: check?.verified ?? null });
      return finish(
        {
          status: "SUCCEEDED",
          output,
          summary: check?.detail ?? tool!.summarize?.(output, input),
          forModel: truncate(JSON.stringify(output)),
          isError: false,
        },
        "OK",
      );
    } catch (err) {
      const message = err instanceof AppError ? err.message : "The change could not be made.";
      if (!(err instanceof AppError)) console.error("[ai] automatic action failed:", logSafeError(err));
      return finish({ status: "FAILED", error: message, forModel: message, isError: true }, "ERROR");
    }
  }

  // Read: bounded retries for transient failures only.
  let attempt = 0;
  for (;;) {
    attempt++;
    await updateStep(db, step.id, { attempts: attempt });
    try {
      const output = await withTimeout(tool!.execute(db, actor, input), LIMITS.stepTimeoutMs, ctx.signal);
      return finish(
        {
          status: "SUCCEEDED",
          output,
          summary: tool!.summarize?.(output, input) ?? "Done",
          forModel: truncate(JSON.stringify(output)),
          isError: false,
        },
        "OK",
      );
    } catch (err) {
      if (ctx.signal?.aborted) {
        return finish(
          { status: "CANCELLED", error: "Stopped", forModel: "Cancelled.", isError: true },
          "ERROR",
        );
      }
      if (isTransient(err) && attempt <= LIMITS.maxReadRetries) {
        const row = await updateStep(db, step.id, {
          error: `Attempt ${attempt} failed (${err instanceof Error ? err.message : "error"}); retrying.`,
        });
        emit({ type: "step", step: stepView(row) });
        await sleep(150 * 2 ** (attempt - 1));
        continue;
      }
      const message =
        err instanceof AppError
          ? err.message
          : err instanceof StepTimeoutError
            ? err.message
            : "The lookup failed.";
      if (!(err instanceof AppError)) console.error("[ai] tool failed:", logSafeError(err));
      return finish({ status: "FAILED", error: message, forModel: message, isError: true }, "ERROR");
    }
  }
}

/** Prepare a standard-risk write: describe it, snapshot its target, and wait for the user. */
async function prepare(
  ctx: RunContext,
  step: StepRow,
  tool: ToolDef,
  input: Record<string, unknown>,
  callId: string,
): Promise<StepOutcome> {
  const { db, actor } = ctx;
  let summary = tool.name;
  let precondition: Record<string, unknown> | null = null;
  try {
    if (tool.describe) summary = await tool.describe(db, actor, input);
    if (tool.precondition) precondition = await tool.precondition(db, actor, input);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    // e.g. the task or assignee does not exist in this organization: nothing is prepared.
    return { status: "FAILED", error: err.message, forModel: err.message, isError: true };
  }
  ctx.counters.writes++;
  const inputHash = hashInput(tool.name, input);
  const [action] = await db
    .insert(aiActions)
    .values({
      orgId: actor.orgId,
      conversationId: ctx.conversationId,
      userId: actor.userId,
      toolUseId: callId,
      toolName: tool.name,
      input,
      inputHash,
      summary,
      precondition,
      runId: ctx.runId,
      stepId: step.id,
      expiresAt: new Date(Date.now() + LIMITS.actionTtlMs),
    })
    .returning();
  await audit(db, actor, {
    action: "ai.action_proposed",
    entityType: "ai_action",
    entityId: action!.id,
    summary: `Assistant prepared: ${summary}`,
    metadata: { toolName: tool.name, conversationId: ctx.conversationId, runId: ctx.runId },
  });
  ctx.emit({
    type: "action",
    action: { id: action!.id, toolName: tool.name, summary, inputHash, expiresAt: action!.expiresAt },
  });
  return {
    status: "AWAITING_CONFIRMATION",
    summary: `Prepared: ${summary}`,
    actionId: action!.id,
    forModel: JSON.stringify({
      status: "awaiting_user_confirmation",
      prepared: summary,
      note: "Not executed. The user must press Confirm in the interface within 10 minutes.",
    }),
    isError: false,
  };
}

function truncate(json: string) {
  return json.length > TOOL_RESULT_LIMIT ? `${json.slice(0, TOOL_RESULT_LIMIT)}… [truncated]` : json;
}

/** A small copy of a result for the step record (full results are not kept). */
function compact(output: unknown): unknown {
  const json = JSON.stringify(output) ?? "null";
  return json.length <= 4000 ? output : { truncated: true, preview: json.slice(0, 4000) };
}
