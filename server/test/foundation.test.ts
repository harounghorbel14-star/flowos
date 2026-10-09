import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { verifyPassword } from "../src/auth/password";
import { auditEvents } from "../src/db/schema";
import { appRouter } from "../src/trpc/router";
import { addMember, anonCaller, callerFor, createOrg, createUser, db, resetLimiters } from "./helpers";

beforeEach(() => resetLimiters());

describe("authentication", () => {
  it("signs up, stores a scrypt hash, and logs in", async () => {
    const email = `a-${randomUUID()}@example.test`;
    let cookie: string | undefined;
    const caller = anonCaller({ setSessionCookie: (t) => (cookie = t) });
    const { user } = await caller.auth.signup({ email, name: "Ada", password: "longpassword1" });
    expect(cookie).toBeTruthy();
    const row = await db().execute(sql`select password_hash from users where id = ${user.id}`);
    const hash = String(row.rows[0]!.password_hash);
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(hash).not.toContain("longpassword1");
    expect(await verifyPassword("longpassword1", hash)).toBe(true);

    const login = await anonCaller().auth.login({ email: email.toUpperCase(), password: "longpassword1" });
    expect(login.user.id).toBe(user.id);
  });

  it("rejects wrong passwords and unknown emails with the same message", async () => {
    const user = await createUser();
    const wrong = anonCaller().auth.login({ email: user.email, password: "nope-nope-1" });
    await expect(wrong).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Incorrect email or password.",
    });
    const unknown = anonCaller().auth.login({ email: "nobody@example.test", password: "nope-nope-1" });
    await expect(unknown).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Incorrect email or password.",
    });
  });

  it("rejects duplicate emails and weak passwords", async () => {
    const user = await createUser();
    resetLimiters();
    await expect(
      anonCaller().auth.signup({ email: user.email, name: "Dup", password: "longpassword1" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      anonCaller().auth.signup({ email: "weak@example.test", name: "W", password: "short" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rate-limits repeated login attempts", async () => {
    const caller = anonCaller({ ip: "10.0.0.99" });
    for (let i = 0; i < 10; i++) {
      await expect(
        caller.auth.login({ email: "x@example.test", password: "bad-password-1" }),
      ).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    }
    await expect(
      caller.auth.login({ email: "x@example.test", password: "bad-password-1" }),
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
  });

  it("blocks protected procedures for logged-out users", async () => {
    const { org } = await createOrg();
    const anon = anonCaller({ requestedOrgId: org.id });
    await expect(anon.employees.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anon.tasks.create({ title: "x" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anon.orgs.create({ name: "Nope" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await anon.auth.me()).toBeNull();
  });
});

describe("organizations and tenancy", () => {
  it("creates an org with the creator as owner and a linked directory profile", async () => {
    const { owner, org, as } = await createOrg("Northwind Studio");
    const me = await callerFor(owner).auth.me();
    expect(me?.organizations).toEqual([expect.objectContaining({ id: org.id, role: "OWNER" })]);
    const profile = await as(owner).employees.me();
    expect(profile).not.toBeNull();
    expect(org.taskPrefix).toBe("NOR");
  });

  it("refuses access to an organization the user does not belong to", async () => {
    const a = await createOrg("Tenant A");
    const b = await createOrg("Tenant B");
    const intruder = callerFor(b.owner, a.org.id);
    await expect(intruder.orgs.current()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(intruder.employees.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(intruder.tasks.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(intruder.audit.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a missing or malformed organization header", async () => {
    const user = await createUser();
    await expect(callerFor(user).employees.list({})).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(callerFor(user, "not-a-uuid").employees.list({})).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(callerFor(user, randomUUID()).employees.list({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("members, roles and invitations", () => {
  it("invites by single-use token bound to the invited email", async () => {
    const { owner, as } = await createOrg();
    const invitee = await createUser("Ivy Invitee");
    const stranger = await createUser("Sam Stranger");
    const invite = await as(owner).orgs.invite({ email: invitee.email, role: "MEMBER" });

    const preview = await anonCaller().orgs.previewInvitation({ token: invite.token });
    expect(preview).toMatchObject({ state: "PENDING", role: "MEMBER" });

    await expect(callerFor(stranger).orgs.acceptInvitation({ token: invite.token })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await callerFor(invitee).orgs.acceptInvitation({ token: invite.token });
    await expect(callerFor(invitee).orgs.acceptInvitation({ token: invite.token })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const members = await as(owner).orgs.members();
    expect(members.map((m) => m.userId)).toContain(invitee.id);

    // Inviter receives an in-app notification.
    const notes = await as(owner).notifications.list({});
    expect(notes.items.some((n) => n.type === "MEMBER_JOINED")).toBe(true);
  });

  it("auto-links an accepted invite to an existing directory profile with the same email", async () => {
    const { owner, org, as } = await createOrg();
    const user = await createUser("Lina Linked");
    const employee = await as(owner).employees.create({
      firstName: "Lina",
      lastName: "Linked",
      email: user.email,
    });
    const invite = await as(owner).orgs.invite({ email: user.email, role: "MEMBER" });
    await callerFor(user).orgs.acceptInvitation({ token: invite.token });
    const me = await callerFor(user, org.id).employees.me();
    expect(me?.id).toBe(employee.id);
  });

  it("prevents members from managing members and admins from managing owners", async () => {
    const { owner, org, as } = await createOrg();
    const admin = await addMember(org.id, owner, "ADMIN");
    const member = await addMember(org.id, owner, "MEMBER");
    const members = await as(owner).orgs.members();
    const ownerMembership = members.find((m) => m.userId === owner.id)!;
    const memberMembership = members.find((m) => m.userId === member.id)!;

    await expect(as(member).orgs.invite({ email: "x@example.test", role: "MEMBER" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      as(member).orgs.changeRole({ membershipId: memberMembership.membershipId, role: "ADMIN" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      as(admin).orgs.changeRole({ membershipId: ownerMembership.membershipId, role: "MEMBER" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(admin).orgs.invite({ email: "o@example.test", role: "OWNER" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // Admin may promote a member to manager.
    await as(admin).orgs.changeRole({ membershipId: memberMembership.membershipId, role: "MANAGER" });
    const after = await as(owner).orgs.members();
    expect(after.find((m) => m.userId === member.id)?.role).toBe("MANAGER");
  });

  it("keeps at least one owner", async () => {
    const { owner, as } = await createOrg();
    await expect(as(owner).orgs.leave()).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("removed members immediately lose access", async () => {
    const { owner, org, as } = await createOrg();
    const member = await addMember(org.id, owner, "MEMBER");
    const membership = (await as(owner).orgs.members()).find((m) => m.userId === member.id)!;
    expect((await as(member).tasks.list({})).total).toBe(0);
    await as(owner).orgs.removeMember({ membershipId: membership.membershipId });
    await expect(as(member).tasks.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("cannot manage memberships of another organization by guessed ID", async () => {
    const a = await createOrg("Alpha Co");
    const b = await createOrg("Beta Co");
    const bMember = await addMember(b.org.id, b.owner, "MEMBER");
    const bMembership = (await b.as(b.owner).orgs.members()).find((m) => m.userId === bMember.id)!;
    await expect(
      a.as(a.owner).orgs.changeRole({ membershipId: bMembership.membershipId, role: "ADMIN" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      a.as(a.owner).orgs.removeMember({ membershipId: bMembership.membershipId }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("audit log", () => {
  it("records mutations and is readable only with audit:read", async () => {
    const { owner, org, as } = await createOrg();
    const member = await addMember(org.id, owner, "MEMBER");
    await as(owner).departments.create({ name: "Operations" });
    const log = await as(owner).audit.list({});
    const actions = log.items.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["org.created", "invitation.created", "department.created"]),
    );
    await expect(as(member).audit.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("is append-only at the database level", async () => {
    const { owner, as } = await createOrg();
    await as(owner).departments.create({ name: "Finance" });
    await expect(db().update(auditEvents).set({ summary: "tampered" })).rejects.toThrow();
    await expect(db().delete(auditEvents)).rejects.toThrow();
    await expect(db().execute(sql`truncate audit_events`)).rejects.toThrow();
  });

  it("exposes no API to modify or delete audit records", () => {
    const auditProcedures = Object.keys(appRouter._def.procedures).filter((k) => k.startsWith("audit."));
    expect(auditProcedures).toEqual(["audit.list"]);
  });
});
