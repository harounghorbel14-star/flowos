import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { label, type Role } from "@shared/domain";
import { ROLE_RANK } from "@shared/permissions";
import type { Database, Tx } from "../../db/client";
import { employees, invitations, memberships, organizations, users } from "../../db/schema";
import { assertCan, type Actor } from "../../lib/actor";
import { audit } from "../../lib/audit";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { generateToken, hashToken } from "../../lib/tokens";
import { notify } from "../notifications/service";
import { assertWithinLimit } from "../billing/entitlements";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "org";
}

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  const firstName = parts.shift() ?? name;
  return { firstName, lastName: parts.join(" ") || "—" };
}

export async function createOrganization(
  db: Database,
  user: { id: string; email: string; name: string },
  input: { name: string; addMeAsEmployee: boolean; jobTitle?: string | null },
  ip: string | null,
) {
  return db.transaction(async (tx) => {
    const base = slugify(input.name);
    let slug = base;
    for (let attempt = 0; attempt < 5; attempt++) {
      const [taken] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.slug, slug))
        .limit(1);
      if (!taken) break;
      slug = `${base}-${generateToken().slice(0, 6).toLowerCase()}`;
    }
    const prefix = (input.name.replace(/[^A-Za-z]/g, "").slice(0, 3) || "FLW").toUpperCase();
    const [org] = await tx
      .insert(organizations)
      .values({ name: input.name.trim(), slug, taskPrefix: prefix, createdByUserId: user.id })
      .returning();
    await tx.insert(memberships).values({ orgId: org!.id, userId: user.id, role: "OWNER" });
    const actor = { userId: user.id, orgId: org!.id, ip };
    await audit(tx, actor, {
      action: "org.created",
      entityType: "organization",
      entityId: org!.id,
      summary: `Created organization ${org!.name}`,
    });
    if (input.addMeAsEmployee) {
      const [employee] = await tx
        .insert(employees)
        .values({
          orgId: org!.id,
          userId: user.id,
          email: user.email,
          jobTitle: input.jobTitle?.trim() || null,
          ...splitName(user.name),
        })
        .returning({ id: employees.id });
      await audit(tx, actor, {
        action: "employee.created",
        entityType: "employee",
        entityId: employee!.id,
        summary: `Added ${user.name} to the directory`,
      });
    }
    return org!;
  });
}

export async function getOrganization(db: Database, actor: Actor) {
  const [org] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      taskPrefix: organizations.taskPrefix,
      createdAt: organizations.createdAt,
    })
    .from(organizations)
    .where(eq(organizations.id, actor.orgId))
    .limit(1);
  if (!org) throw notFound("Organization");
  return { ...org, role: actor.role };
}

export async function updateOrganization(
  db: Database,
  actor: Actor,
  input: { name?: string; taskPrefix?: string },
) {
  assertCan(actor, "org:update");
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(organizations).where(eq(organizations.id, actor.orgId)).limit(1);
    if (!before) throw notFound("Organization");
    const [after] = await tx
      .update(organizations)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(organizations.id, actor.orgId))
      .returning();
    await audit(tx, actor, {
      action: "org.updated",
      entityType: "organization",
      entityId: actor.orgId,
      summary: "Updated organization settings",
      metadata: { before: { name: before.name, taskPrefix: before.taskPrefix }, after: input },
    });
    return after!;
  });
}

// ─── Members ─────────────────────────────────────────────────────────────────

export async function listMembers(db: Database, actor: Actor) {
  assertCan(actor, "member:read");
  return db
    .select({
      membershipId: memberships.id,
      userId: users.id,
      name: users.name,
      email: users.email,
      role: memberships.role,
      joinedAt: memberships.createdAt,
      employeeId: employees.id,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(
      employees,
      and(eq(employees.orgId, memberships.orgId), eq(employees.userId, memberships.userId)),
    )
    .where(eq(memberships.orgId, actor.orgId))
    .orderBy(users.name);
}

/** An actor may only manage members strictly below them, except owners who may manage anyone. */
function assertCanManageRole(actor: Actor, targetRole: Role) {
  if (actor.role === "OWNER") return;
  if (ROLE_RANK[targetRole] >= ROLE_RANK[actor.role]) {
    throw forbidden("You can only manage members with a lower role than your own.");
  }
}

async function lockOwners(tx: Tx, orgId: string) {
  return tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.role, "OWNER")))
    .for("update");
}

async function getMembershipForUpdate(tx: Tx, actor: Actor, membershipId: string) {
  const [target] = await tx
    .select({ id: memberships.id, userId: memberships.userId, role: memberships.role, name: users.name })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.id, membershipId), eq(memberships.orgId, actor.orgId)))
    .for("update", { of: memberships })
    .limit(1);
  if (!target) throw notFound("Member");
  return target;
}

export async function changeRole(db: Database, actor: Actor, input: { membershipId: string; role: Role }) {
  assertCan(actor, "member:manage");
  return db.transaction(async (tx) => {
    const owners = await lockOwners(tx, actor.orgId);
    const target = await getMembershipForUpdate(tx, actor, input.membershipId);
    if (target.userId === actor.userId) throw badRequest("You cannot change your own role.");
    assertCanManageRole(actor, target.role);
    assertCanManageRole(actor, input.role);
    if (target.role === "OWNER" && input.role !== "OWNER" && owners.length <= 1) {
      throw badRequest("An organization must keep at least one owner.");
    }
    if (target.role === input.role) return { ok: true };
    await tx
      .update(memberships)
      .set({ role: input.role, updatedAt: new Date() })
      .where(and(eq(memberships.id, target.id), eq(memberships.orgId, actor.orgId)));
    await audit(tx, actor, {
      action: "member.role_changed",
      entityType: "membership",
      entityId: target.id,
      summary: `Changed ${target.name}'s role from ${label(target.role)} to ${label(input.role)}`,
      metadata: { userId: target.userId, from: target.role, to: input.role },
    });
    return { ok: true };
  });
}

export async function removeMember(db: Database, actor: Actor, membershipId: string) {
  assertCan(actor, "member:manage");
  return db.transaction(async (tx) => {
    const owners = await lockOwners(tx, actor.orgId);
    const target = await getMembershipForUpdate(tx, actor, membershipId);
    if (target.userId === actor.userId) throw badRequest("Use “Leave organization” to remove yourself.");
    assertCanManageRole(actor, target.role);
    if (target.role === "OWNER" && owners.length <= 1)
      throw badRequest("An organization must keep at least one owner.");
    await tx
      .delete(memberships)
      .where(and(eq(memberships.id, target.id), eq(memberships.orgId, actor.orgId)));
    await audit(tx, actor, {
      action: "member.removed",
      entityType: "membership",
      entityId: target.id,
      summary: `Removed ${target.name} from the organization`,
      metadata: { userId: target.userId, role: target.role },
    });
    return { ok: true };
  });
}

export async function leaveOrganization(db: Database, actor: Actor) {
  return db.transaction(async (tx) => {
    const owners = await lockOwners(tx, actor.orgId);
    if (actor.role === "OWNER" && owners.length <= 1) {
      throw badRequest("You are the only owner. Transfer ownership before leaving.");
    }
    await tx
      .delete(memberships)
      .where(and(eq(memberships.orgId, actor.orgId), eq(memberships.userId, actor.userId)));
    await audit(tx, actor, {
      action: "member.left",
      entityType: "membership",
      entityId: actor.userId,
      summary: "Left the organization",
    });
    return { ok: true };
  });
}

// ─── Invitations ─────────────────────────────────────────────────────────────

export async function createInvitation(db: Database, actor: Actor, input: { email: string; role: Role }) {
  assertCan(actor, "member:manage");
  assertCanManageRole(actor, input.role);
  const email = input.email.trim().toLowerCase();
  return db.transaction(async (tx) => {
    const [existingMember] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.orgId, actor.orgId), eq(sql`lower(${users.email})`, email)))
      .limit(1);
    if (existingMember) throw conflict("That person is already a member.");

    // Supersede any previous pending invitation for the same address.
    await tx
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(invitations.orgId, actor.orgId),
          eq(invitations.email, email),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      );
    // Members plus open invitations must fit the plan.
    await assertWithinLimit(tx, actor.orgId, "members");
    const token = generateToken();
    const [invite] = await tx
      .insert(invitations)
      .values({
        orgId: actor.orgId,
        email,
        role: input.role,
        tokenHash: hashToken(token),
        invitedByUserId: actor.userId,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      })
      .returning({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        expiresAt: invitations.expiresAt,
      });
    await audit(tx, actor, {
      action: "invitation.created",
      entityType: "invitation",
      entityId: invite!.id,
      summary: `Invited ${email} as ${label(input.role)}`,
    });
    // The raw token is returned exactly once so the inviter can share the link.
    return { ...invite!, token };
  });
}

export async function listInvitations(db: Database, actor: Actor) {
  assertCan(actor, "member:manage");
  return db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
      invitedBy: users.name,
    })
    .from(invitations)
    .leftJoin(users, eq(users.id, invitations.invitedByUserId))
    .where(
      and(
        eq(invitations.orgId, actor.orgId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(invitations.createdAt));
}

export async function revokeInvitation(db: Database, actor: Actor, invitationId: string) {
  assertCan(actor, "member:manage");
  return db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.orgId, actor.orgId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .returning({ id: invitations.id, email: invitations.email });
    if (!revoked) throw notFound("Invitation");
    await audit(tx, actor, {
      action: "invitation.revoked",
      entityType: "invitation",
      entityId: revoked.id,
      summary: `Revoked invitation for ${revoked.email}`,
    });
    return { ok: true };
  });
}

async function findInvitation(db: Tx, token: string) {
  const [invite] = await db
    .select({
      id: invitations.id,
      orgId: invitations.orgId,
      orgName: organizations.name,
      email: invitations.email,
      role: invitations.role,
      expiresAt: invitations.expiresAt,
      acceptedAt: invitations.acceptedAt,
      revokedAt: invitations.revokedAt,
      invitedByUserId: invitations.invitedByUserId,
    })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.orgId))
    .where(eq(invitations.tokenHash, hashToken(token)))
    .limit(1);
  return invite;
}

function invitationState(invite: { expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null }) {
  if (invite.acceptedAt) return "ACCEPTED" as const;
  if (invite.revokedAt) return "REVOKED" as const;
  if (invite.expiresAt.getTime() <= Date.now()) return "EXPIRED" as const;
  return "PENDING" as const;
}

/** Preview for the accept page. Only someone holding the token can call this. */
export async function previewInvitation(db: Database, token: string) {
  const invite = await findInvitation(db, token);
  if (!invite) throw notFound("Invitation");
  return { orgName: invite.orgName, email: invite.email, role: invite.role, state: invitationState(invite) };
}

export async function acceptInvitation(
  db: Database,
  user: { id: string; email: string; name: string },
  token: string,
  ip: string | null,
) {
  return db.transaction(async (tx) => {
    const invite = await findInvitation(tx, token);
    if (!invite) throw notFound("Invitation");
    const state = invitationState(invite);
    if (state !== "PENDING") throw badRequest(`This invitation is ${state.toLowerCase()}.`);
    if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
      throw forbidden("This invitation was sent to a different email address.");
    }
    // Conditional update makes acceptance single-use even under concurrent requests.
    const [claimed] = await tx
      .update(invitations)
      .set({ acceptedAt: new Date(), acceptedByUserId: user.id })
      .where(
        and(eq(invitations.id, invite.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)),
      )
      .returning({ id: invitations.id });
    if (!claimed) throw badRequest("This invitation has already been used.");
    // Checked again on acceptance: the plan may have changed since the invitation was sent.
    await assertWithinLimit(tx, invite.orgId, "members");

    const [existing] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.orgId, invite.orgId), eq(memberships.userId, user.id)))
      .limit(1);
    if (!existing) {
      await tx.insert(memberships).values({ orgId: invite.orgId, userId: user.id, role: invite.role });
    }
    const actor = { userId: user.id, orgId: invite.orgId, ip };
    await audit(tx, actor, {
      action: "invitation.accepted",
      entityType: "invitation",
      entityId: invite.id,
      summary: `${user.name} joined as ${label(invite.role)}`,
    });

    // Link to an existing, unlinked directory entry with the same email, if any.
    const [linked] = await tx
      .update(employees)
      .set({ userId: user.id, updatedAt: new Date() })
      .where(
        and(
          eq(employees.orgId, invite.orgId),
          eq(sql`lower(${employees.email})`, user.email.toLowerCase()),
          isNull(employees.userId),
        ),
      )
      .returning({ id: employees.id });
    if (linked) {
      await audit(tx, actor, {
        action: "employee.linked",
        entityType: "employee",
        entityId: linked.id,
        summary: `Linked ${user.name}'s account to their directory profile`,
      });
    }
    if (invite.invitedByUserId) {
      await notify(tx, {
        orgId: invite.orgId,
        userId: invite.invitedByUserId,
        actorUserId: user.id,
        type: "MEMBER_JOINED",
        title: `${user.name} joined ${invite.orgName}`,
        link: "/settings/members",
      });
    }
    return { orgId: invite.orgId };
  });
}
