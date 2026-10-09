import type { TriggerType } from "@shared/workflows";
import type { Tx } from "../db/client";
import { domainEvents } from "../db/schema";
import type { Actor } from "./actor";

/**
 * Record a domain event in the transactional outbox. Must be called inside
 * the same transaction as the change; the workflow dispatcher picks it up
 * only after commit.
 *
 * `subjectEmployeeId` / `subjectUserId` identify the person the event is
 * about, so workflow actions can target them or their manager.
 */
export async function emit(
  tx: Tx,
  actor: Actor,
  type: TriggerType,
  entityId: string,
  payload: Record<string, unknown> & { subjectEmployeeId: string | null; subjectUserId: string | null },
): Promise<void> {
  await tx.insert(domainEvents).values({
    orgId: actor.orgId,
    type,
    entityId,
    actorUserId: actor.userId,
    payload,
    depth: actor.workflowDepth ?? 0,
  });
}
