import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { Database, Tx } from "../../db/client";
import { aiMemories, aiRuns } from "../../db/schema";
import { assertCan, can, type Actor } from "../../lib/actor";
import { audit } from "../../lib/audit";
import { badRequest, forbidden, notFound } from "../../lib/errors";

/**
 * Scoped memory.
 *  - PREFERENCE: one user's saved preferences. Written only by that user.
 *  - ORG_KNOWLEDGE: operational facts for the whole organization. Written by people who can
 *    change organization settings; readable by everyone who can use the assistant.
 *  - OUTCOME: changes the engine executed AND verified by re-reading the records.
 * Summaries of previous runs live on ai_runs. Nothing a model writes is stored as memory.
 */

export const RETENTION = {
  outcomeDays: 90,
  /** Previous-run summaries offered as context. */
  recentRunSummaries: 5,
  maxPreferencesPerUser: 50,
  maxOrgKnowledge: 100,
} as const;

export type MemoryScope = "PREFERENCE" | "ORG_KNOWLEDGE" | "OUTCOME";

const live = () => or(isNull(aiMemories.expiresAt), gt(aiMemories.expiresAt, new Date()));

/** Entries this user may see: their own preferences and outcomes, and their organization's knowledge. */
export async function listMemories(db: Database, actor: Actor) {
  assertCan(actor, "ai:use");
  const rows = await db
    .select({
      id: aiMemories.id,
      scope: aiMemories.scope,
      content: aiMemories.content,
      source: aiMemories.source,
      sourceRef: aiMemories.sourceRef,
      expiresAt: aiMemories.expiresAt,
      createdAt: aiMemories.createdAt,
      mine: sql<boolean>`${aiMemories.userId} = ${actor.userId}`,
    })
    .from(aiMemories)
    .where(
      and(
        eq(aiMemories.orgId, actor.orgId),
        or(eq(aiMemories.userId, actor.userId), eq(aiMemories.scope, "ORG_KNOWLEDGE")),
        live(),
      ),
    )
    .orderBy(desc(aiMemories.createdAt))
    .limit(200);
  return {
    items: rows,
    canManageOrgKnowledge: can(actor, "org:update"),
    retention: { outcomeDays: RETENTION.outcomeDays },
  };
}

function clean(content: string) {
  const text = content.replace(/\s+/g, " ").trim();
  if (text.length < 2 || text.length > 500) throw badRequest("Write between 2 and 500 characters.");
  return text;
}

export async function addMemory(
  db: Database,
  actor: Actor,
  input: { scope: "PREFERENCE" | "ORG_KNOWLEDGE"; content: string },
) {
  assertCan(actor, "ai:use");
  const content = clean(input.content);
  if (input.scope === "ORG_KNOWLEDGE" && !can(actor, "org:update"))
    throw forbidden("Only people who manage the organization can add organization knowledge.");
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(aiMemories)
    .where(
      and(
        eq(aiMemories.orgId, actor.orgId),
        eq(aiMemories.scope, input.scope),
        input.scope === "PREFERENCE" ? eq(aiMemories.userId, actor.userId) : undefined,
      ),
    );
  const max = input.scope === "PREFERENCE" ? RETENTION.maxPreferencesPerUser : RETENTION.maxOrgKnowledge;
  if (n >= max) throw badRequest(`At most ${max} entries; delete one first.`);
  const [row] = await db
    .insert(aiMemories)
    .values({
      orgId: actor.orgId,
      userId: input.scope === "PREFERENCE" ? actor.userId : null,
      scope: input.scope,
      content,
      source: "user",
      createdByUserId: actor.userId,
    })
    .returning();
  if (input.scope === "ORG_KNOWLEDGE")
    await audit(db, actor, {
      action: "ai.org_knowledge_added",
      entityType: "ai_memory",
      entityId: row!.id,
      summary: "Added organization knowledge for the assistant",
    });
  return row!;
}

export async function deleteMemory(db: Database, actor: Actor, id: string) {
  assertCan(actor, "ai:use");
  const [row] = await db
    .select({ id: aiMemories.id, scope: aiMemories.scope, userId: aiMemories.userId })
    .from(aiMemories)
    .where(and(eq(aiMemories.orgId, actor.orgId), eq(aiMemories.id, id)));
  // Someone else's personal entry is reported as missing, not forbidden: its existence is private.
  if (!row || (row.scope !== "ORG_KNOWLEDGE" && row.userId !== actor.userId)) throw notFound("Memory");
  if (row.scope === "ORG_KNOWLEDGE" && !can(actor, "org:update")) throw forbidden();
  await db.delete(aiMemories).where(and(eq(aiMemories.orgId, actor.orgId), eq(aiMemories.id, id)));
  if (row.scope === "ORG_KNOWLEDGE")
    await audit(db, actor, {
      action: "ai.org_knowledge_deleted",
      entityType: "ai_memory",
      entityId: id,
      summary: "Deleted organization knowledge for the assistant",
    });
  return { ok: true };
}

/** Delete everything personal the assistant remembers about this user in this organization. */
export async function clearMyMemory(db: Database, actor: Actor) {
  assertCan(actor, "ai:use");
  const removed = await db
    .delete(aiMemories)
    .where(and(eq(aiMemories.orgId, actor.orgId), eq(aiMemories.userId, actor.userId)))
    .returning({ id: aiMemories.id });
  return { removed: removed.length };
}

/** Called by the engine only, after a change was executed and re-read successfully. */
export async function recordOutcome(
  db: Tx,
  actor: Actor,
  content: string,
  sourceRef: Record<string, unknown>,
) {
  await db.insert(aiMemories).values({
    orgId: actor.orgId,
    userId: actor.userId,
    scope: "OUTCOME",
    content: content.slice(0, 500),
    source: "engine",
    sourceRef,
    createdByUserId: actor.userId,
    expiresAt: new Date(Date.now() + RETENTION.outcomeDays * 86_400_000),
  });
}

export async function purgeExpiredMemories(db: Database) {
  const removed = await db
    .delete(aiMemories)
    .where(lt(aiMemories.expiresAt, new Date()))
    .returning({ id: aiMemories.id });
  return removed.length;
}

/**
 * Context for a run: labelled by where it came from, so neither the engine nor a model
 * mistakes a preference or an old summary for a current record.
 */
export async function memoryContext(db: Database, actor: Actor, conversationId: string) {
  const [entries, runs] = await Promise.all([
    db
      .select({ scope: aiMemories.scope, content: aiMemories.content, createdAt: aiMemories.createdAt })
      .from(aiMemories)
      .where(
        and(
          eq(aiMemories.orgId, actor.orgId),
          or(eq(aiMemories.userId, actor.userId), eq(aiMemories.scope, "ORG_KNOWLEDGE")),
          live(),
        ),
      )
      .orderBy(desc(aiMemories.createdAt))
      .limit(40),
    db
      .select({ summary: aiRuns.summary, startedAt: aiRuns.startedAt })
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.orgId, actor.orgId),
          eq(aiRuns.userId, actor.userId),
          sql`${aiRuns.conversationId} <> ${conversationId}`,
          sql`${aiRuns.summary} is not null`,
        ),
      )
      .orderBy(desc(aiRuns.startedAt))
      .limit(RETENTION.recentRunSummaries),
  ]);
  const pick = (scope: MemoryScope) => entries.filter((e) => e.scope === scope).map((e) => e.content);
  return {
    preferences: pick("PREFERENCE").slice(0, 20),
    orgKnowledge: pick("ORG_KNOWLEDGE").slice(0, 20),
    verifiedOutcomes: pick("OUTCOME").slice(0, 10),
    previousRuns: runs.map((r) => `${r.startedAt.toISOString().slice(0, 10)}: ${r.summary}`),
  };
}

export type MemoryContext = Awaited<ReturnType<typeof memoryContext>>;

export function memoryContextText(m: MemoryContext): string | null {
  const section = (title: string, lines: string[]) =>
    lines.length ? `${title}:\n${lines.map((l) => `- ${l}`).join("\n")}` : null;
  const parts = [
    section("Saved preferences of this user (set by the user)", m.preferences),
    section("Organization knowledge (written by administrators)", m.orgKnowledge),
    section("Verified outcomes of earlier assistant actions", m.verifiedOutcomes),
    section("Earlier requests in other conversations (summaries, may be outdated)", m.previousRuns),
  ].filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}
