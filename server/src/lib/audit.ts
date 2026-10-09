import type { Tx } from "../db/client";
import { auditEvents } from "../db/schema";

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}

interface AuditActor {
  userId: string | null;
  orgId: string | null;
  ip?: string | null;
}

/**
 * Write an audit event. Call inside the same transaction as the mutation so
 * the event exists if and only if the change committed.
 */
export async function audit(tx: Tx, actor: AuditActor, entry: AuditEntry): Promise<void> {
  await tx.insert(auditEvents).values({
    orgId: actor.orgId,
    actorUserId: actor.userId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    summary: entry.summary,
    metadata: entry.metadata ?? {},
    ip: actor.ip ?? null,
  });
}

/** Shallow diff of changed fields for audit metadata. */
export function diff<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): Record<string, unknown> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    const from = before[key];
    const to = after[key];
    if (to !== undefined && String(from ?? "") !== String(to ?? "")) changes[key] = { from, to };
  }
  return { changes };
}
