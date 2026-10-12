import { and, asc, desc, eq, sql, sum } from "drizzle-orm";
import type { Database } from "../../db/client";
import { aiActions, aiConversations, aiMessages, aiUsage } from "../../db/schema";
import { assertCan, can, type Actor } from "../../lib/actor";
import { audit } from "../../lib/audit";
import { AppError, badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { logSafeError } from "../../lib/logging";
import { getEntitlements } from "../billing/entitlements";
import { ownConversation, routing } from "./engine";
import { hashInput } from "./executor";
import { SUPPORTED_COMMANDS } from "./intents";
import { recordOutcome } from "./memory";
import { NEVER_AUTONOMOUS } from "./policy";
import { runsOfConversation, settleRun, updateStep } from "./runs";
import { getModelRuntime, getRuntimeSelection } from "./runtime";
import { partsFromStored } from "./transcript";
import { findTool, toolsFor } from "./tools";

export { aiLimiter, runTurn, SYSTEM_PROMPT } from "./engine";
export { hashInput } from "./executor";
export type { TurnEvent } from "./events";
export { fitHistory } from "./transcript";

// ─── Conversations ───────────────────────────────────────────────────────────

export async function createConversation(db: Database, actor: Actor, title?: string) {
  assertCan(actor, "ai:use");
  const [c] = await db
    .insert(aiConversations)
    .values({
      orgId: actor.orgId,
      userId: actor.userId,
      title: title?.trim().slice(0, 120) || "New conversation",
    })
    .returning();
  return c!;
}

export async function listConversations(db: Database, actor: Actor) {
  assertCan(actor, "ai:use");
  return db
    .select({ id: aiConversations.id, title: aiConversations.title, updatedAt: aiConversations.updatedAt })
    .from(aiConversations)
    .where(and(eq(aiConversations.orgId, actor.orgId), eq(aiConversations.userId, actor.userId)))
    .orderBy(desc(aiConversations.updatedAt))
    .limit(50);
}

/** Deletes the transcript, its runs and steps (cascade). Changes it already made are kept. */
export async function deleteConversation(db: Database, actor: Actor, id: string) {
  await ownConversation(db, actor, id);
  await db
    .delete(aiConversations)
    .where(and(eq(aiConversations.orgId, actor.orgId), eq(aiConversations.id, id)));
  return { ok: true };
}

/** Transcript for display: text and tool activity, the runs with their steps, and prepared actions. */
export async function getConversation(db: Database, actor: Actor, id: string) {
  const conversation = await ownConversation(db, actor, id);
  const [messages, actions, usage, runs] = await Promise.all([
    db
      .select({
        id: aiMessages.id,
        role: aiMessages.role,
        content: aiMessages.content,
        runId: aiMessages.runId,
        createdAt: aiMessages.createdAt,
      })
      .from(aiMessages)
      .where(and(eq(aiMessages.orgId, actor.orgId), eq(aiMessages.conversationId, id)))
      .orderBy(asc(aiMessages.id)),
    db
      .select({
        id: aiActions.id,
        toolUseId: aiActions.toolUseId,
        toolName: aiActions.toolName,
        summary: aiActions.summary,
        inputHash: aiActions.inputHash,
        status: aiActions.status,
        result: aiActions.result,
        error: aiActions.error,
        verified: aiActions.verified,
        runId: aiActions.runId,
        stepId: aiActions.stepId,
        expiresAt: aiActions.expiresAt,
      })
      .from(aiActions)
      .where(and(eq(aiActions.orgId, actor.orgId), eq(aiActions.conversationId, id)))
      .orderBy(asc(aiActions.createdAt)),
    db
      .select({
        requests: sql<number>`count(*)`.mapWith(Number),
        inputTokens: sum(aiUsage.inputTokens).mapWith(Number),
        outputTokens: sum(aiUsage.outputTokens).mapWith(Number),
        cacheReadTokens: sum(aiUsage.cacheReadTokens).mapWith(Number),
      })
      .from(aiUsage)
      .where(and(eq(aiUsage.orgId, actor.orgId), eq(aiUsage.conversationId, id))),
    runsOfConversation(db, actor, id),
  ]);

  const items: Array<
    | { kind: "user"; text: string; at: Date; runId: string | null }
    | { kind: "assistant"; text: string; at: Date; runId: string | null }
    | { kind: "tool"; name: string; toolUseId: string; at: Date; runId: string | null }
  > = [];
  for (const m of messages) {
    for (const part of partsFromStored(m.content)) {
      if (part.type === "text" && part.text) {
        // Context, memory and action-update notes are for a model; the UI shows cards instead.
        if (m.role === "user" && /^\[(Action update|Context|Memory)\]/.test(part.text)) continue;
        items.push({ kind: m.role, text: part.text, at: m.createdAt, runId: m.runId });
      } else if (part.type === "tool_call") {
        items.push({ kind: "tool", name: part.name, toolUseId: part.id, at: m.createdAt, runId: m.runId });
      }
    }
  }
  return { id: conversation.id, title: conversation.title, items, actions, runs, usage: usage[0] };
}

// ─── Prepared actions ────────────────────────────────────────────────────────

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Execute a prepared action. Only the user who received the proposal can confirm it, in the same
 * organization, before it expires, with the exact input hash they were shown, with their current
 * permissions, and only while the target is still in the state it was in when prepared. The
 * status transition is guarded so an action runs at most once. Afterwards the records are re-read
 * to verify the change; only a verified change is remembered as an outcome.
 */
export async function confirmAction(
  db: Database,
  actor: Actor,
  input: { actionId: string; inputHash: string },
) {
  assertCan(actor, "ai:use");
  const [action] = await db
    .select()
    .from(aiActions)
    .where(
      and(
        eq(aiActions.orgId, actor.orgId),
        eq(aiActions.id, input.actionId),
        eq(aiActions.userId, actor.userId),
      ),
    );
  if (!action) throw notFound("Action");
  if (action.status !== "PROPOSED") throw conflict(`This action was already ${action.status.toLowerCase()}.`);
  const settleStep = async (
    status: "SUCCEEDED" | "FAILED" | "SKIPPED",
    patch: { error?: string | null; summary?: string; verified?: boolean | null },
  ) => {
    if (!action.stepId) return;
    await updateStep(db, action.stepId, {
      status,
      error: patch.error ?? null,
      ...(patch.summary ? { resultSummary: patch.summary } : {}),
      verified: patch.verified ?? null,
      finishedAt: new Date(),
    });
    if (action.runId) await settleRun(db, action.runId);
  };
  if (action.expiresAt.getTime() <= Date.now()) {
    await db
      .update(aiActions)
      .set({ status: "EXPIRED", decidedAt: new Date() })
      .where(and(eq(aiActions.id, action.id), eq(aiActions.status, "PROPOSED")));
    await settleStep("SKIPPED", { error: "Expired without confirmation." });
    throw badRequest("This action expired. Ask the assistant to prepare it again.");
  }
  if (input.inputHash !== action.inputHash || hashInput(action.toolName, action.input) !== action.inputHash) {
    throw badRequest("The action does not match what was prepared. Ask the assistant to prepare it again.");
  }
  const tool = findTool(action.toolName);
  if (!tool || tool.risk !== "standard") throw badRequest("Unknown action.");
  // Re-authorize against the user's current role.
  if (!tool.permissions.every((p) => can(actor, p))) throw forbidden();
  const parsed = tool.schema.safeParse(action.input);
  if (!parsed.success) throw badRequest("The prepared input is no longer valid.");

  let result: Record<string, unknown>;
  try {
    result = await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(aiActions)
        .set({ status: "EXECUTED", decidedAt: new Date() })
        .where(and(eq(aiActions.id, action.id), eq(aiActions.status, "PROPOSED")))
        .returning({ id: aiActions.id });
      if (!claimed) throw conflict("This action was already handled.");
      if (tool.precondition) {
        const now = await tool.precondition(tx, actor, parsed.data);
        if (!same(now, action.precondition)) {
          throw new AppError(
            "CONFLICT",
            "The record changed since this was prepared, so this confirmation no longer applies. Ask the assistant again.",
          );
        }
      }
      const out = (await tool.execute(tx, actor, parsed.data)) as Record<string, unknown>;
      await tx.update(aiActions).set({ result: out }).where(eq(aiActions.id, action.id));
      await audit(tx, actor, {
        action: tool.auditAction ?? "ai.action_executed",
        entityType: "ai_action",
        entityId: action.id,
        summary: `Confirmed assistant action: ${action.summary}`,
        metadata: { toolName: action.toolName, conversationId: action.conversationId, runId: action.runId },
      });
      return out;
    });
  } catch (err) {
    if (
      err instanceof AppError &&
      err.code === "CONFLICT" &&
      err.message.startsWith("This action was already")
    )
      throw err;
    // The transaction rolled back; record the failure so the user (and a model) see it.
    const message = err instanceof AppError ? err.message : "The action failed unexpectedly.";
    await db
      .update(aiActions)
      .set({ status: "FAILED", error: message, decidedAt: new Date() })
      .where(and(eq(aiActions.id, action.id), eq(aiActions.status, "PROPOSED")));
    if (!(err instanceof AppError)) console.error("[ai] action failed:", logSafeError(err));
    await settleStep("FAILED", { error: message });
    return { status: "FAILED" as const, error: message };
  }

  // Verify outside the write transaction, by reading the records back through the services.
  let verified = false;
  let detail = "Executed (no verification defined)";
  try {
    if (tool.verify) ({ verified, detail } = await tool.verify(db, actor, parsed.data, result));
  } catch (err) {
    detail = err instanceof AppError ? `Could not verify: ${err.message}` : "Could not verify the result.";
  }
  await db.update(aiActions).set({ verified }).where(eq(aiActions.id, action.id));
  if (verified)
    await recordOutcome(db, actor, `${action.summary} (${new Date().toISOString().slice(0, 10)})`, {
      actionId: action.id,
    });
  await settleStep("SUCCEEDED", { summary: detail, verified });
  return { status: "EXECUTED" as const, result, verified, detail };
}

export async function rejectAction(db: Database, actor: Actor, actionId: string) {
  const [updated] = await db
    .update(aiActions)
    .set({ status: "REJECTED", decidedAt: new Date() })
    .where(
      and(
        eq(aiActions.orgId, actor.orgId),
        eq(aiActions.id, actionId),
        eq(aiActions.userId, actor.userId),
        eq(aiActions.status, "PROPOSED"),
      ),
    )
    .returning({ id: aiActions.id, stepId: aiActions.stepId, runId: aiActions.runId });
  if (!updated) throw notFound("Pending action");
  if (updated.stepId) {
    await updateStep(db, updated.stepId, {
      status: "SKIPPED",
      error: "Rejected by you.",
      finishedAt: new Date(),
    });
    if (updated.runId) await settleRun(db, updated.runId);
  }
  return { ok: true };
}

// ─── Status ──────────────────────────────────────────────────────────────────

/**
 * What the assistant can do on this server, for this user. Rules mode is always available; the
 * model runtime is reported with where it runs. No request is made to a hosted API here.
 */
export async function aiStatus(db?: Database, actor?: Actor) {
  const selection = getRuntimeSelection();
  const runtime = getModelRuntime();
  const health = runtime ? await runtime.health() : null;
  const includedInPlan =
    db && actor ? (await getEntitlements(db, actor.orgId)).features.includes("assistant") : true;
  return {
    /** Kept for older clients: the assistant can always answer (rules mode needs no model). */
    configured: true,
    model: runtime?.info.model ?? null,
    includedInPlan,
    runtime: runtime
      ? {
          provider: runtime.info.provider,
          model: runtime.info.model,
          hosting: runtime.info.hosting,
          reachable: health?.ok ?? false,
          detail: health?.detail ?? null,
        }
      : null,
    configError: selection.configError,
    routing: routing(),
    supportedCommands: SUPPORTED_COMMANDS,
    neverAutonomous: NEVER_AUTONOMOUS,
    tools: actor ? toolsFor(actor).map((t) => ({ name: t.name, risk: t.risk })) : [],
  };
}
