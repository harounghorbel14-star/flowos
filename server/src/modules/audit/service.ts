import { and, count, desc, eq } from "drizzle-orm";
import type { Database } from "../../db/client";
import { auditEvents, users } from "../../db/schema";
import { assertCan, type Actor } from "../../lib/actor";
import { offsetOf, toPage, type PageInput } from "../../lib/pagination";

const columns = {
  id: auditEvents.id,
  action: auditEvents.action,
  entityType: auditEvents.entityType,
  entityId: auditEvents.entityId,
  summary: auditEvents.summary,
  metadata: auditEvents.metadata,
  createdAt: auditEvents.createdAt,
  actorUserId: auditEvents.actorUserId,
  actorName: users.name,
};

/** Organization-wide audit log. Read-only by design: there is no update or delete API. */
export async function listAuditEvents(
  db: Database,
  actor: Actor,
  input: PageInput & { entityType?: string; actorUserId?: string },
) {
  assertCan(actor, "audit:read");
  const where = and(
    eq(auditEvents.orgId, actor.orgId),
    input.entityType ? eq(auditEvents.entityType, input.entityType) : undefined,
    input.actorUserId ? eq(auditEvents.actorUserId, input.actorUserId) : undefined,
  );
  const [items, [total]] = await Promise.all([
    db
      .select(columns)
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorUserId))
      .where(where)
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(input.pageSize)
      .offset(offsetOf(input)),
    db.select({ n: count() }).from(auditEvents).where(where),
  ]);
  return toPage(items, total?.n ?? 0, input);
}

/**
 * History of a single entity. Callers must have already verified the actor
 * may read that entity — this function only guarantees tenant scoping.
 */
export async function entityHistory(
  db: Database,
  actor: Actor,
  entityType: string,
  entityId: string,
  limit = 50,
) {
  return db
    .select(columns)
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .where(
      and(
        eq(auditEvents.orgId, actor.orgId),
        eq(auditEvents.entityType, entityType),
        eq(auditEvents.entityId, entityId),
      ),
    )
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(limit);
}
