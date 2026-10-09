import { afterEach, describe, expect, it, vi } from "vitest";
import { logSafeError } from "../src/lib/logging";
import { addMember, createOrg } from "./helpers";

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
