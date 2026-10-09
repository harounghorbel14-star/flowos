import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { addDaysISO, todayISO } from "../src/lib/dates";
import { riskReasons } from "../src/modules/projects/service";
import { addMember, createOrg, db } from "./helpers";

async function setup() {
  const ctx = await createOrg();
  const { owner, org, as } = ctx;
  const member = await addMember(org.id, owner, "MEMBER", "Mia Member");
  const memberEmployee = await as(owner).employees.create({
    firstName: "Mia",
    lastName: "Member",
    email: `mia-${randomUUID()}@e.test`,
    userId: member.id,
  });
  return { ...ctx, member, memberEmployee };
}

describe("projects", () => {
  it("computes progress and risk from real task rows", async () => {
    const { owner, as } = await setup();
    const p = await as(owner).projects.create({
      name: "Launch",
      status: "ACTIVE",
      dueDate: addDaysISO(todayISO(), 3),
    });
    let detail = await as(owner).projects.get({ id: p.id });
    expect(detail.stats).toMatchObject({ total: 0, done: 0, progress: 0 });
    expect(detail.risk).toEqual([]);

    const t1 = await as(owner).tasks.create({ title: "One", projectId: p.id });
    await as(owner).tasks.create({ title: "Two", projectId: p.id, status: "BLOCKED" });
    await as(owner).tasks.create({ title: "Three", projectId: p.id, dueDate: addDaysISO(todayISO(), -1) });
    await as(owner).tasks.update({ id: t1.id, status: "DONE" });

    detail = await as(owner).projects.get({ id: p.id });
    expect(detail.stats).toMatchObject({ total: 3, done: 1, blocked: 1, overdue: 1 });
    expect(detail.stats.progress).toBeCloseTo(1 / 3);
    expect(detail.risk.join(" | ")).toMatch(/33% of tasks done/);
    expect(detail.risk).toContain("1 overdue task");
    expect(detail.risk).toContain("1 blocked task");
  });

  it("risk rules are explicit and ignore finished projects", () => {
    const stats = { total: 4, done: 1, blocked: 0, overdue: 0, progress: 0.25 };
    expect(riskReasons({ status: "COMPLETED", dueDate: "2000-01-01" }, stats)).toEqual([]);
    expect(riskReasons({ status: "ACTIVE", dueDate: "2000-01-01" }, stats, "2026-01-01")).toEqual([
      "Past due date (2000-01-01)",
    ]);
    expect(riskReasons({ status: "ACTIVE", dueDate: null }, stats)).toEqual([]);
  });

  it("refuses to delete a project that has tasks", async () => {
    const { owner, as } = await setup();
    const p = await as(owner).projects.create({ name: "Keep" });
    await as(owner).tasks.create({ title: "child", projectId: p.id });
    await expect(as(owner).projects.delete({ id: p.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const empty = await as(owner).projects.create({ name: "Empty" });
    await expect(as(owner).projects.delete({ id: empty.id })).resolves.toEqual({ ok: true });
  });

  it("members cannot create or edit projects", async () => {
    const { owner, member, as } = await setup();
    const p = await as(owner).projects.create({ name: "Owned" });
    await expect(as(member).projects.create({ name: "Mine" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(member).projects.update({ id: p.id, name: "Hijack" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("sets completedAt when completed and clears it when reopened", async () => {
    const { owner, as } = await setup();
    const p = await as(owner).projects.create({ name: "Cycle" });
    expect((await as(owner).projects.update({ id: p.id, status: "COMPLETED" })).completedAt).toBeInstanceOf(
      Date,
    );
    expect((await as(owner).projects.update({ id: p.id, status: "ACTIVE" })).completedAt).toBeNull();
  });

  it("rejects cross-org owners and members", async () => {
    const a = await setup();
    const b = await setup();
    await expect(
      a.as(a.owner).projects.create({ name: "X", ownerEmployeeId: b.memberEmployee.id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      a.as(a.owner).projects.create({ name: "X", memberIds: [b.memberEmployee.id] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("tasks", () => {
  it("allocates per-organization task numbers", async () => {
    const a = await setup();
    const b = await setup();
    const a1 = await a.as(a.owner).tasks.create({ title: "a1" });
    const a2 = await a.as(a.owner).tasks.create({ title: "a2" });
    const b1 = await b.as(b.owner).tasks.create({ title: "b1" });
    expect([a1.number, a2.number, b1.number]).toEqual([1, 2, 1]);
    const found = await a.as(a.owner).tasks.list({ search: `${a.org.taskPrefix}-2` });
    expect(found.items.map((t) => t.id)).toEqual([a2.id]);
  });

  it("allocates unique numbers under concurrent creation", async () => {
    const { owner, as } = await setup();
    const created = await Promise.all(
      Array.from({ length: 10 }, (_, i) => as(owner).tasks.create({ title: `c${i}` })),
    );
    expect(new Set(created.map((t) => t.number)).size).toBe(10);
  });

  it("keeps completedAt consistent with status", async () => {
    const { owner, as } = await setup();
    const t = await as(owner).tasks.create({ title: "x" });
    expect(t.completedAt).toBeNull();
    const done = await as(owner).tasks.update({ id: t.id, status: "DONE" });
    expect(done.completedAt).toBeInstanceOf(Date);
    const again = await as(owner).tasks.update({ id: t.id, title: "renamed" });
    expect(again.completedAt?.getTime()).toBe(done.completedAt?.getTime());
    const reopened = await as(owner).tasks.update({ id: t.id, status: "REVIEW" });
    expect(reopened.completedAt).toBeNull();
    // The database itself refuses an inconsistent row.
    await expect(
      db().execute(sql`update tasks set completed_at = null, status = 'DONE' where id = ${t.id}`),
    ).rejects.toThrow();
  });

  it("notifies the assignee and records activity", async () => {
    const { owner, member, memberEmployee, as } = await setup();
    const t = await as(owner).tasks.create({
      title: "Prepare report",
      assigneeEmployeeId: memberEmployee.id,
    });
    const notes = await as(member).notifications.list({ unreadOnly: true });
    expect(notes.items[0]).toMatchObject({ type: "TASK_ASSIGNED", link: `/tasks/${t.id}` });
    expect(await as(member).notifications.unreadCount()).toBe(1);
    await as(member).notifications.markRead({});
    expect(await as(member).notifications.unreadCount()).toBe(0);

    await as(member).tasks.update({ id: t.id, status: "IN_PROGRESS" });
    await as(member).tasks.addComment({ taskId: t.id, body: "On it" });
    const detail = await as(owner).tasks.get({ id: t.id });
    expect(detail.history.map((h) => h.action)).toEqual([
      "task.commented",
      "task.status_changed",
      "task.created",
    ]);
    expect(detail.comments.map((c) => c.body)).toEqual(["On it"]);
    expect(detail.key).toMatch(/^[A-Z]+-\d+$/);
  });

  it("members can update only their own or assigned tasks", async () => {
    const { owner, org, member, memberEmployee, as } = await setup();
    const other = await addMember(org.id, owner, "MEMBER", "Otto Other");
    const assigned = await as(owner).tasks.create({
      title: "assigned",
      assigneeEmployeeId: memberEmployee.id,
    });
    const unrelated = await as(owner).tasks.create({ title: "unrelated" });
    const own = await as(member).tasks.create({ title: "own" });

    await expect(as(member).tasks.update({ id: assigned.id, status: "DONE" })).resolves.toBeTruthy();
    await expect(as(member).tasks.update({ id: own.id, priority: "HIGH" })).resolves.toBeTruthy();
    await expect(as(member).tasks.update({ id: unrelated.id, status: "DONE" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(as(other).tasks.delete({ id: own.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await as(member).tasks.get({ id: unrelated.id })).canEdit).toBe(false);
  });

  it("viewers cannot create, edit or comment", async () => {
    const { owner, org, as } = await setup();
    const viewer = await addMember(org.id, owner, "VIEWER");
    const t = await as(owner).tasks.create({ title: "read only" });
    await expect(as(viewer).tasks.create({ title: "no" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(viewer).tasks.update({ id: t.id, title: "no" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(as(viewer).tasks.addComment({ taskId: t.id, body: "no" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(as(viewer).tasks.get({ id: t.id })).resolves.toBeTruthy();
  });

  it("blocks every cross-tenant read and write by guessed IDs", async () => {
    const a = await setup();
    const b = await setup();
    const bProject = await b.as(b.owner).projects.create({ name: "B secret" });
    const bTask = await b.as(b.owner).tasks.create({ title: "B secret task", projectId: bProject.id });
    const bComment = await b.as(b.owner).tasks.addComment({ taskId: bTask.id, body: "secret" });
    const A = a.as(a.owner);

    await expect(A.tasks.get({ id: bTask.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(A.tasks.update({ id: bTask.id, title: "pwned" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(A.tasks.delete({ id: bTask.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(A.tasks.addComment({ taskId: bTask.id, body: "hi" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(A.tasks.deleteComment({ commentId: bComment.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(A.projects.get({ id: bProject.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(A.projects.update({ id: bProject.id, name: "pwned" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(A.projects.delete({ id: bProject.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Attaching own task to a foreign project or assignee is rejected.
    await expect(A.tasks.create({ title: "x", projectId: bProject.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      A.tasks.create({ title: "x", assigneeEmployeeId: b.memberEmployee.id }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    // Filters with foreign IDs simply return nothing.
    expect((await A.tasks.list({ projectId: bProject.id })).total).toBe(0);

    const intact = await b.as(b.owner).tasks.get({ id: bTask.id });
    expect(intact.title).toBe("B secret task");
    expect(intact.comments).toHaveLength(1);
  });

  it("filters by mine, overdue, status and priority", async () => {
    const { owner, member, memberEmployee, as } = await setup();
    const yesterday = addDaysISO(todayISO(), -1);
    await as(owner).tasks.create({
      title: "mine-overdue",
      assigneeEmployeeId: memberEmployee.id,
      dueDate: yesterday,
    });
    await as(owner).tasks.create({
      title: "mine-urgent",
      assigneeEmployeeId: memberEmployee.id,
      priority: "URGENT",
    });
    await as(owner).tasks.create({ title: "other", status: "BLOCKED" });
    const titles = async (input: Parameters<ReturnType<typeof as>["tasks"]["list"]>[0]) =>
      (await as(member).tasks.list(input)).items.map((t) => t.title).sort();
    expect(await titles({ mine: true })).toEqual(["mine-overdue", "mine-urgent"]);
    expect(await titles({ overdue: true })).toEqual(["mine-overdue"]);
    expect(await titles({ statuses: ["BLOCKED"] })).toEqual(["other"]);
    expect(await titles({ priorities: ["URGENT"] })).toEqual(["mine-urgent"]);
    expect(await titles({ mine: true, sort: "priority" })).toHaveLength(2);
  });

  it("refuses assignment to terminated employees", async () => {
    const { owner, as } = await setup();
    const gone = await as(owner).employees.create({
      firstName: "Gone",
      lastName: "Person",
      email: `g-${randomUUID()}@e.test`,
      status: "TERMINATED",
    });
    await expect(as(owner).tasks.create({ title: "x", assigneeEmployeeId: gone.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});
