import { and, asc, count, desc, eq, inArray, ne, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { LEAVE_TYPES, type ApprovalStatus, type ApprovalType, type Role } from "@shared/domain";
import { ROLE_PERMISSIONS } from "@shared/permissions";
import type { Database, Tx } from "../../db/client";
import { approvalEvents, approvalRequests, employees, memberships, users } from "../../db/schema";
import { assertCan, can, type Actor } from "../../lib/actor";
import { audit } from "../../lib/audit";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { offsetOf, toPage, type PageInput } from "../../lib/pagination";
import { emit } from "../../lib/events";
import { notify } from "../notifications/service";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Type-specific payload schemas. Unknown keys are stripped. */
export const PAYLOAD_SCHEMAS = {
  LEAVE: z
    .object({ leaveType: z.enum(LEAVE_TYPES), startDate: isoDate, endDate: isoDate })
    .refine((p) => p.endDate >= p.startDate, {
      message: "End date cannot be before start date.",
      path: ["endDate"],
    }),
  HR: z.object({ category: z.string().trim().min(1).max(80) }),
  DOCUMENT: z.object({ documentName: z.string().trim().min(1).max(200) }),
  PURCHASE: z.object({
    amount: z.number().positive().max(1_000_000_000),
    currency: z.string().regex(/^[A-Z]{3}$/),
    vendor: z.string().trim().min(1).max(120),
  }),
  GENERAL: z.object({}),
} satisfies Record<ApprovalType, z.ZodTypeAny>;

/**
 * The approval state machine. PENDING is the only non-terminal state; every
 * transition out of it is guarded by a conditional UPDATE so two concurrent
 * decisions cannot both succeed.
 */
export const TRANSITIONS: Record<ApprovalStatus, readonly ApprovalStatus[]> = {
  PENDING: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: [],
  REJECTED: [],
  CANCELLED: [],
};

export function canTransition(from: ApprovalStatus, to: ApprovalStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

const DECIDER_ROLES = (Object.keys(ROLE_PERMISSIONS) as Role[]).filter((r) =>
  ROLE_PERMISSIONS[r].has("approval:decide"),
);

const requester = alias(users, "requester");
const approver = alias(users, "approver");

const columns = {
  id: approvalRequests.id,
  type: approvalRequests.type,
  title: approvalRequests.title,
  description: approvalRequests.description,
  payload: approvalRequests.payload,
  status: approvalRequests.status,
  decisionComment: approvalRequests.decisionComment,
  decidedAt: approvalRequests.decidedAt,
  createdAt: approvalRequests.createdAt,
  requesterUserId: approvalRequests.requesterUserId,
  requesterName: requester.name,
  approverUserId: approvalRequests.approverUserId,
  approverName: approver.name,
};

function baseQuery(db: Tx) {
  return db
    .select(columns)
    .from(approvalRequests)
    .innerJoin(requester, eq(requester.id, approvalRequests.requesterUserId))
    .innerJoin(approver, eq(approver.id, approvalRequests.approverUserId));
}

/** Rows the actor may see: their own requests, ones they must decide, or all with approval:read_all. */
function visibility(actor: Actor): SQL | undefined {
  if (can(actor, "approval:read_all")) return undefined;
  return or(
    eq(approvalRequests.requesterUserId, actor.userId),
    eq(approvalRequests.approverUserId, actor.userId),
  );
}

export async function approverOptions(db: Database, actor: Actor) {
  return db
    .select({ userId: users.id, name: users.name, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.orgId, actor.orgId),
        inArray(memberships.role, DECIDER_ROLES),
        ne(memberships.userId, actor.userId),
      ),
    )
    .orderBy(asc(users.name));
}

export interface CreateApprovalInput {
  type: ApprovalType;
  title: string;
  description?: string | null;
  approverUserId: string;
  payload: unknown;
}

export async function createRequest(db: Database, actor: Actor, input: CreateApprovalInput) {
  assertCan(actor, "approval:create");
  if (input.approverUserId === actor.userId) throw badRequest("You cannot approve your own request.");
  const parsed = PAYLOAD_SCHEMAS[input.type].safeParse(input.payload ?? {});
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid request details.");

  return db.transaction(async (tx) => {
    const [approverMember] = await tx
      .select({ role: memberships.role, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.orgId, actor.orgId), eq(memberships.userId, input.approverUserId)))
      .limit(1);
    if (!approverMember) throw badRequest("The approver is not a member of this organization.");
    if (!ROLE_PERMISSIONS[approverMember.role].has("approval:decide")) {
      throw badRequest("The chosen approver is not allowed to decide approvals.");
    }
    const [request] = await tx
      .insert(approvalRequests)
      .values({
        orgId: actor.orgId,
        type: input.type,
        title: input.title,
        description: input.description ?? null,
        payload: parsed.data as Record<string, unknown>,
        requesterUserId: actor.userId,
        approverUserId: input.approverUserId,
      })
      .returning();
    await tx.insert(approvalEvents).values({
      orgId: actor.orgId,
      requestId: request!.id,
      actorUserId: actor.userId,
      kind: "CREATED",
    });
    await audit(tx, actor, {
      action: "approval.requested",
      entityType: "approval",
      entityId: request!.id,
      summary: `Requested approval: ${request!.title}`,
      metadata: { type: input.type, approverUserId: input.approverUserId },
    });
    await notify(tx, {
      orgId: actor.orgId,
      userId: input.approverUserId,
      actorUserId: actor.userId,
      type: "APPROVAL_REQUESTED",
      title: `Approval requested: ${request!.title}`,
      link: `/approvals/${request!.id}`,
    });
    return request!;
  });
}

export async function listRequests(
  db: Database,
  actor: Actor,
  input: PageInput & { box: "inbox" | "outbox" | "all"; status?: ApprovalStatus; type?: ApprovalType },
) {
  const filters: (SQL | undefined)[] = [eq(approvalRequests.orgId, actor.orgId)];
  if (input.box === "inbox") filters.push(eq(approvalRequests.approverUserId, actor.userId));
  else if (input.box === "outbox") filters.push(eq(approvalRequests.requesterUserId, actor.userId));
  else filters.push(visibility(actor));
  if (input.status) filters.push(eq(approvalRequests.status, input.status));
  if (input.type) filters.push(eq(approvalRequests.type, input.type));
  const where = and(...filters);
  const [items, [total]] = await Promise.all([
    baseQuery(db)
      .where(where)
      .orderBy(desc(approvalRequests.createdAt))
      .limit(input.pageSize)
      .offset(offsetOf(input)),
    db.select({ n: count() }).from(approvalRequests).where(where),
  ]);
  return toPage(items, total?.n ?? 0, input);
}

export async function getRequest(db: Database, actor: Actor, id: string) {
  const [request] = await baseQuery(db)
    .where(and(eq(approvalRequests.orgId, actor.orgId), eq(approvalRequests.id, id), visibility(actor)))
    .limit(1);
  if (!request) throw notFound("Approval request");
  const events = await db
    .select({
      id: approvalEvents.id,
      kind: approvalEvents.kind,
      comment: approvalEvents.comment,
      createdAt: approvalEvents.createdAt,
      actorUserId: approvalEvents.actorUserId,
      actorName: users.name,
    })
    .from(approvalEvents)
    .leftJoin(users, eq(users.id, approvalEvents.actorUserId))
    .where(and(eq(approvalEvents.orgId, actor.orgId), eq(approvalEvents.requestId, id)))
    .orderBy(asc(approvalEvents.createdAt));
  const isPending = request.status === "PENDING";
  return {
    ...request,
    events,
    canDecide: isPending && request.approverUserId === actor.userId && can(actor, "approval:decide"),
    canCancel: isPending && request.requesterUserId === actor.userId,
  };
}

export async function decide(
  db: Database,
  actor: Actor,
  input: { id: string; decision: "APPROVED" | "REJECTED"; comment?: string | null },
) {
  assertCan(actor, "approval:decide");
  if (input.decision === "REJECTED" && !input.comment?.trim()) {
    throw badRequest("Please explain why the request is rejected.");
  }
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(approvalRequests)
      .where(
        and(eq(approvalRequests.orgId, actor.orgId), eq(approvalRequests.id, input.id), visibility(actor)),
      )
      .for("update");
    if (!current) throw notFound("Approval request");
    if (current.approverUserId !== actor.userId)
      throw forbidden("Only the designated approver can decide this request.");
    if (!canTransition(current.status, input.decision)) {
      throw conflict(`This request is already ${current.status.toLowerCase()}.`);
    }
    // Guarded transition: succeeds only while still PENDING.
    const [updated] = await tx
      .update(approvalRequests)
      .set({
        status: input.decision,
        decisionComment: input.comment?.trim() || null,
        decidedAt: new Date(),
        decidedByUserId: actor.userId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(approvalRequests.orgId, actor.orgId),
          eq(approvalRequests.id, input.id),
          eq(approvalRequests.status, "PENDING"),
        ),
      )
      .returning();
    if (!updated) throw conflict("This request has already been decided.");
    await tx.insert(approvalEvents).values({
      orgId: actor.orgId,
      requestId: input.id,
      actorUserId: actor.userId,
      kind: input.decision,
      comment: input.comment?.trim() || null,
    });
    await audit(tx, actor, {
      action: input.decision === "APPROVED" ? "approval.approved" : "approval.rejected",
      entityType: "approval",
      entityId: input.id,
      summary: `${input.decision === "APPROVED" ? "Approved" : "Rejected"}: ${updated.title}`,
    });
    await notify(tx, {
      orgId: actor.orgId,
      userId: updated.requesterUserId,
      actorUserId: actor.userId,
      type: "APPROVAL_DECIDED",
      title: `Your request “${updated.title}” was ${input.decision.toLowerCase()}`,
      body: input.comment?.trim() || null,
      link: `/approvals/${input.id}`,
    });
    const [requesterInfo] = await tx
      .select({ name: users.name, employeeId: employees.id })
      .from(users)
      .leftJoin(employees, and(eq(employees.orgId, actor.orgId), eq(employees.userId, users.id)))
      .where(eq(users.id, updated.requesterUserId));
    await emit(tx, actor, "approval.decided", input.id, {
      approvalId: input.id,
      title: updated.title,
      type: updated.type,
      decision: input.decision,
      requesterName: requesterInfo?.name ?? null,
      subjectEmployeeId: requesterInfo?.employeeId ?? null,
      subjectUserId: updated.requesterUserId,
    });
    return updated;
  });
}

export async function cancel(db: Database, actor: Actor, id: string) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.orgId, actor.orgId), eq(approvalRequests.id, id), visibility(actor)))
      .for("update");
    if (!current) throw notFound("Approval request");
    if (current.requesterUserId !== actor.userId)
      throw forbidden("Only the requester can cancel this request.");
    if (!canTransition(current.status, "CANCELLED")) {
      throw conflict(`This request is already ${current.status.toLowerCase()}.`);
    }
    const [updated] = await tx
      .update(approvalRequests)
      .set({
        status: "CANCELLED",
        decidedAt: new Date(),
        decidedByUserId: actor.userId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(approvalRequests.orgId, actor.orgId),
          eq(approvalRequests.id, id),
          eq(approvalRequests.status, "PENDING"),
        ),
      )
      .returning();
    if (!updated) throw conflict("This request has already been decided.");
    await tx
      .insert(approvalEvents)
      .values({ orgId: actor.orgId, requestId: id, actorUserId: actor.userId, kind: "CANCELLED" });
    await audit(tx, actor, {
      action: "approval.cancelled",
      entityType: "approval",
      entityId: id,
      summary: `Cancelled request: ${updated.title}`,
    });
    await notify(tx, {
      orgId: actor.orgId,
      userId: updated.approverUserId,
      actorUserId: actor.userId,
      type: "APPROVAL_CANCELLED",
      title: `“${updated.title}” was withdrawn`,
      link: `/approvals/${id}`,
    });
    return updated;
  });
}

export async function addComment(db: Database, actor: Actor, id: string, comment: string) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.orgId, actor.orgId), eq(approvalRequests.id, id), visibility(actor)))
      .limit(1);
    if (!current) throw notFound("Approval request");
    await tx.insert(approvalEvents).values({
      orgId: actor.orgId,
      requestId: id,
      actorUserId: actor.userId,
      kind: "COMMENTED",
      comment,
    });
    await audit(tx, actor, {
      action: "approval.commented",
      entityType: "approval",
      entityId: id,
      summary: `Commented on request: ${current.title}`,
    });
    const other = actor.userId === current.requesterUserId ? current.approverUserId : current.requesterUserId;
    await notify(tx, {
      orgId: actor.orgId,
      userId: other,
      actorUserId: actor.userId,
      type: "APPROVAL_COMMENTED",
      title: `New comment on “${current.title}”`,
      body: comment.slice(0, 200),
      link: `/approvals/${id}`,
    });
    return { ok: true };
  });
}
