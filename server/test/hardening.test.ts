import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, SESSION_MAX_AGE_MS, validateSession } from "../src/auth/session";
import { sessions } from "../src/db/schema";
import { logSafeError } from "../src/lib/logging";
import { addMember, anonCaller, callerFor, createOrg, createUser, db, resetLimiters } from "./helpers";

/** Regression tests for defects found in the stabilization audit. */

async function demote(ctx: Awaited<ReturnType<typeof createOrg>>, userId: string) {
  const membership = (await ctx.as(ctx.owner).orgs.members()).find((m) => m.userId === userId)!;
  await ctx.as(ctx.owner).orgs.changeRole({ membershipId: membership.membershipId, role: "VIEWER" });
}

afterEach(() => vi.restoreAllMocks());

describe("write permissions after demotion", () => {
  it("a member demoted to viewer can no longer delete their own task", async () => {
    const ctx = await createOrg();
    const member = await addMember(ctx.org.id, ctx.owner, "MEMBER");
    const task = await ctx.as(member).tasks.create({ title: "Mine" });
    await demote(ctx, member.id);
    await expect(ctx.as(member).tasks.delete({ id: task.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(ctx.as(ctx.owner).tasks.get({ id: task.id })).resolves.toBeTruthy();
  });

  it("a member demoted to viewer can no longer delete their own comment", async () => {
    const ctx = await createOrg();
    const member = await addMember(ctx.org.id, ctx.owner, "MEMBER");
    const task = await ctx.as(ctx.owner).tasks.create({ title: "Shared" });
    const comment = await ctx.as(member).tasks.addComment({ taskId: task.id, body: "note" });
    await demote(ctx, member.id);
    await expect(ctx.as(member).tasks.deleteComment({ commentId: comment.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("members still delete their own tasks and comments", async () => {
    const ctx = await createOrg();
    const member = await addMember(ctx.org.id, ctx.owner, "MEMBER");
    const task = await ctx.as(member).tasks.create({ title: "Mine" });
    const comment = await ctx.as(member).tasks.addComment({ taskId: task.id, body: "note" });
    await expect(ctx.as(member).tasks.deleteComment({ commentId: comment.id })).resolves.toEqual({
      ok: true,
    });
    await expect(ctx.as(member).tasks.delete({ id: task.id })).resolves.toMatchObject({ ok: true });
  });
});

describe("malformed input is a 400, not a 500", () => {
  it("rejects impossible calendar dates", async () => {
    const ctx = await createOrg();
    await expect(ctx.as(ctx.owner).tasks.create({ title: "x", dueDate: "2026-02-31" })).rejects.toMatchObject(
      {
        code: "BAD_REQUEST",
      },
    );
    await expect(
      ctx.as(ctx.owner).approvals.create({
        type: "LEAVE",
        title: "Leave",
        approverUserId: (await addMember(ctx.org.id, ctx.owner, "MANAGER")).id,
        payload: { leaveType: "ANNUAL", startDate: "2026-13-45", endDate: "2026-07-10" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      ctx.as(ctx.owner).tasks.create({ title: "ok", dueDate: "2028-02-29" }),
    ).resolves.toBeTruthy();
  });

  it("maps database data exceptions (NUL byte) to BAD_REQUEST", async () => {
    const ctx = await createOrg();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(ctx.as(ctx.owner).tasks.create({ title: "bad\u0000title" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("error logging", () => {
  it("never includes bound query parameters", () => {
    const driverError = Object.assign(new Error('invalid input syntax for type date: "2026-02-31"'), {
      code: "22008",
      severity: "ERROR",
      table: "tasks",
    });
    const queryError = Object.assign(
      new Error('Failed query: insert into "users" ...\nparams: someone@example.test,scrypt$secret-hash'),
      { name: "DrizzleQueryError", cause: driverError },
    );
    const logged = logSafeError(queryError);
    expect(logged).toContain("database query failed");
    expect(logged).toContain("22008");
    expect(logged).not.toContain("someone@example.test");
    expect(logged).not.toContain("secret-hash");
    expect(logged).not.toContain("2026-02-31");
  });

  it("keeps message and stack for application errors", () => {
    expect(logSafeError(new TypeError("x is undefined"))).toContain("TypeError: x is undefined");
  });
});

describe("account security", () => {
  it("changing the password needs the current one and signs out every other session", async () => {
    const user = await createUser();
    await resetLimiters();
    const meta = { ip: null, userAgent: null };
    const other = await createSession(db(), user.id, meta);
    const current = await createSession(db(), user.id, meta);
    const currentId = (await validateSession(db(), current.token))!.sessionId;

    const { changePassword } = await import("../src/modules/auth/service");
    await expect(
      changePassword(
        db(),
        { userId: user.id, sessionId: currentId },
        { currentPassword: "wrong-pass-1", newPassword: "brand-new-pass-9" },
        meta,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const res = await changePassword(
      db(),
      { userId: user.id, sessionId: currentId },
      { currentPassword: "correct-horse-42", newPassword: "brand-new-pass-9" },
      meta,
    );
    expect(res.otherSessionsSignedOut).toBeGreaterThanOrEqual(2); // the signup session and `other`
    expect(await validateSession(db(), other.token)).toBeNull();
    expect(await validateSession(db(), current.token)).not.toBeNull();

    await resetLimiters();
    await expect(
      anonCaller({ ip: "10.9.9.9" }).auth.login({ email: user.email, password: "correct-horse-42" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("the API rejects a weak new password", async () => {
    const user = await createUser();
    await expect(
      callerFor(user).auth.changePassword({ currentPassword: "correct-horse-42", newPassword: "short" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("sessions expire 90 days after sign-in even when used every day", async () => {
    const user = await createUser();
    const s = await createSession(db(), user.id, { ip: null, userAgent: null });
    const id = (await validateSession(db(), s.token))!.sessionId;
    await db()
      .update(sessions)
      .set({
        createdAt: new Date(Date.now() - SESSION_MAX_AGE_MS - 1000),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .where(eq(sessions.id, id));
    expect(await validateSession(db(), s.token)).toBeNull();
  });

  it("renewal never extends a session past the 90-day limit", async () => {
    const user = await createUser();
    const s = await createSession(db(), user.id, { ip: null, userAgent: null });
    const id = (await validateSession(db(), s.token))!.sessionId;
    const createdAt = new Date(Date.now() - SESSION_MAX_AGE_MS + 5 * 86_400_000); // 5 days left
    await db()
      .update(sessions)
      .set({ createdAt, expiresAt: new Date(Date.now() + 86_400_000) })
      .where(eq(sessions.id, id));
    const renewed = await validateSession(db(), s.token);
    expect(renewed!.expiresAt.getTime()).toBeLessThanOrEqual(createdAt.getTime() + SESSION_MAX_AGE_MS);
  });
});

describe("concurrency", () => {
  it("concurrent opposite manager changes cannot create a reporting cycle", async () => {
    const ctx = await createOrg();
    const mk = (n: string) =>
      ctx
        .as(ctx.owner)
        .employees.create({ firstName: n, lastName: "C", email: `${n}-${Date.now()}@example.test` });
    const [a, b] = await Promise.all([mk("ana"), mk("ben")]);
    for (let i = 0; i < 5; i++) {
      await ctx.as(ctx.owner).employees.update({ id: a.id, managerId: null });
      await ctx.as(ctx.owner).employees.update({ id: b.id, managerId: null });
      const results = await Promise.allSettled([
        ctx.as(ctx.owner).employees.update({ id: a.id, managerId: b.id }),
        ctx.as(ctx.owner).employees.update({ id: b.id, managerId: a.id }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    }
  });

  it("concurrent invitations to one email leave exactly one open invitation", async () => {
    const ctx = await createOrg();
    const email = `dup-${Date.now()}@example.test`;
    await Promise.allSettled(
      Array.from({ length: 4 }, () => ctx.as(ctx.owner).orgs.invite({ email, role: "MEMBER" })),
    );
    const open = await db().execute(
      sql`select count(*)::int as n from invitations
           where org_id = ${ctx.org.id} and email = ${email} and accepted_at is null and revoked_at is null`,
    );
    expect(open.rows[0]).toEqual({ n: 1 });
  });
});
