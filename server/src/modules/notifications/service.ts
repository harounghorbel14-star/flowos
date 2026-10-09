import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import type { NotificationType } from "@shared/domain";
import type { Database, Tx } from "../../db/client";
import { memberships, notifications } from "../../db/schema";
import type { Actor } from "../../lib/actor";
import { offsetOf, toPage, type PageInput } from "../../lib/pagination";

export interface NotifyInput {
  orgId: string;
  /** Recipient. */
  userId: string;
  /** Who caused it. People are never notified about their own actions. */
  actorUserId: string | null;
  type: NotificationType;
  title: string;
  body?: string | null;
  link?: string | null;
}

/**
 * Persist an in-app notification inside the caller's transaction. The
 * recipient must still be a member of the organization; otherwise nothing is
 * written (e.g. an assignee whose account was removed).
 */
export async function notify(tx: Tx, input: NotifyInput): Promise<void> {
  if (input.actorUserId && input.actorUserId === input.userId) return;
  const [member] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.orgId, input.orgId), eq(memberships.userId, input.userId)))
    .limit(1);
  if (!member) return;
  await tx.insert(notifications).values({
    orgId: input.orgId,
    userId: input.userId,
    type: input.type,
    title: input.title.slice(0, 300),
    body: input.body?.slice(0, 1000) ?? null,
    link: input.link?.startsWith("/") ? input.link : null,
  });
}

export async function listNotifications(
  db: Database,
  actor: Actor,
  input: PageInput & { unreadOnly: boolean },
) {
  const where = and(
    eq(notifications.orgId, actor.orgId),
    eq(notifications.userId, actor.userId),
    input.unreadOnly ? isNull(notifications.readAt) : undefined,
  );
  const [items, [total]] = await Promise.all([
    db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt))
      .limit(input.pageSize)
      .offset(offsetOf(input)),
    db.select({ n: count() }).from(notifications).where(where),
  ]);
  return toPage(items, total?.n ?? 0, input);
}

export async function unreadCount(db: Database, actor: Actor): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(notifications)
    .where(
      and(
        eq(notifications.orgId, actor.orgId),
        eq(notifications.userId, actor.userId),
        isNull(notifications.readAt),
      ),
    );
  return row?.n ?? 0;
}

/** Mark specific notifications (or all, when ids is omitted) as read. Scoped to the actor. */
export async function markRead(db: Database, actor: Actor, ids?: string[]) {
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.orgId, actor.orgId),
        eq(notifications.userId, actor.userId),
        isNull(notifications.readAt),
        ids ? inArray(notifications.id, ids) : undefined,
      ),
    )
    .returning({ id: notifications.id });
  return { updated: updated.length };
}
