import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { metricSnapshots } from "../src/db/schema";
import { recordDailySnapshots } from "../src/modules/insights/service";
import { addMember, createOrg, db } from "./helpers";

/** Monday 00:00 UTC of the ISO week `weeksAgo` weeks before the current one, plus `days`. */
const at = (weeksAgo: number, days = 1) =>
  sql`date_trunc('week', now()) - ${`${weeksAgo} weeks`}::interval + ${`${days} days`}::interval`;
const dateAt = (weeksAgo: number, days = 1) => sql`(${at(weeksAgo, days)})::date`;

async function backdate(
  taskId: string,
  created: ReturnType<typeof at>,
  due?: ReturnType<typeof dateAt>,
  completed?: ReturnType<typeof at>,
) {
  await db().execute(sql`update tasks set created_at = ${created},
    due_date = ${due ?? sql`due_date`},
    completed_at = ${completed ?? sql`completed_at`},
    status = ${completed ? "DONE" : sql`status`}
    where id = ${taskId}`);
}

describe("operational trends", () => {
  it("counts weekly created/completed and reconstructs overdue history from real dates", async () => {
    const { owner, as } = await createOrg();
    const t1 = await as(owner).tasks.create({ title: "Late then done" });
    const t2 = await as(owner).tasks.create({ title: "Still late" });
    const t3 = await as(owner).tasks.create({ title: "On time" });
    // t1: created 5 weeks ago, due 4 weeks ago, completed 2 weeks ago → overdue at end of weeks 4 and 3 ago only.
    await backdate(t1.id, at(5), dateAt(4), at(2));
    // t2: created 3 weeks ago, due 3 weeks ago (Tuesday), never done → overdue every week since.
    await backdate(t2.id, at(3), dateAt(3));
    // t3: created this week, no due date.
    await backdate(t3.id, at(0, 0));

    const r = await as(owner).insights.trends();
    expect(r.weeks).toHaveLength(8);
    const byAgo = (n: number) => r.weeks[r.weeks.length - 1 - n]!;
    expect(byAgo(5)).toMatchObject({ created: 1, completed: 0, overdue: 0 });
    expect(byAgo(4)).toMatchObject({ created: 0, overdue: 1 });
    expect(byAgo(3)).toMatchObject({ created: 1, overdue: 2 });
    expect(byAgo(2)).toMatchObject({ completed: 1, overdue: 1 });
    expect(byAgo(0)).toMatchObject({ created: 1, overdue: 1 });
    expect(r.weeks.reduce((s, w) => s + w.created, 0)).toBe(3);
    expect(r.definitions.overdue).toMatch(/reconstructed/);
  });

  it("compares rolling 7-day windows", async () => {
    const { owner, as } = await createOrg();
    const old = await as(owner).tasks.create({ title: "Previous window" });
    await db().execute(sql`update tasks set created_at = now() - interval '10 days' where id = ${old.id}`);
    const done = await as(owner).tasks.create({ title: "Done now" });
    await as(owner).tasks.update({ id: done.id, status: "DONE" });
    const r = await as(owner).insights.trends();
    expect(r.rolling.created).toEqual({ current: 1, previous: 1 });
    expect(r.rolling.completed).toEqual({ current: 1, previous: 0 });
  });

  it("measures approval turnaround and gates sensitive sections by permission", async () => {
    const { owner, org, as } = await createOrg();
    const member = await addMember(org.id, owner, "MEMBER");
    const viewer = await addMember(org.id, owner, "VIEWER");
    for (const hours of [2, 4, 30]) {
      const req = await as(member).approvals.create({
        type: "GENERAL",
        title: `R${hours}`,
        approverUserId: owner.id,
      });
      await as(owner).approvals.decide({ id: req.id, decision: "APPROVED" });
      await db().execute(
        sql`update approval_requests set created_at = decided_at - ${`${hours} hours`}::interval where id = ${req.id}`,
      );
    }
    await as(member).approvals.create({ type: "GENERAL", title: "Pending", approverUserId: owner.id });

    const r = await as(owner).insights.trends();
    const thisWeek = r.approvals!.weeks.at(-1)!;
    expect(thisWeek.decided).toBe(3);
    expect(thisWeek.medianHours).toBeCloseTo(4, 5);
    expect(r.approvals!.pending).toBe(1);
    expect(r.workflows).not.toBeNull();

    const m = await as(member).insights.trends();
    expect(m.approvals).toBeNull();
    expect(m.workflows).toBeNull();
    expect(m.rolling.approvalsDecided).toBeNull();
    await expect(as(viewer).insights.trends()).resolves.toBeTruthy();
  });

  it("counts only the actor's organization", async () => {
    const a = await createOrg();
    const b = await createOrg();
    await b.as(b.owner).tasks.create({ title: "B's task" });
    const r = await a.as(a.owner).insights.trends();
    expect(r.weeks.reduce((s, w) => s + w.created, 0)).toBe(0);
    await expect(b.as(a.owner).insights.trends()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lists workflow failures and notable changes", async () => {
    const { owner, as } = await createOrg();
    await as(owner).projects.create({ name: "Launch" });
    const r = await as(owner).insights.trends();
    expect(r.notable.map((n) => n.action)).toContain("project.created");
    expect(r.workflows!.failing).toEqual([]);
  });

  it("supports 4, 8 and 12 week ranges and rejects others", async () => {
    const { owner, as } = await createOrg();
    expect((await as(owner).insights.trends({ weeks: 4 })).weeks).toHaveLength(4);
    expect((await as(owner).insights.trends({ weeks: 12 })).weeks).toHaveLength(12);
    expect((await as(owner).insights.trends()).range).toBe(8);
    // @ts-expect-error 5 is not an allowed range
    await expect(as(owner).insights.trends({ weeks: 5 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("records daily snapshots and prefers measured overdue counts over reconstruction", async () => {
    const { owner, org, as } = await createOrg();
    const late = await as(owner).tasks.create({ title: "Late" });
    await backdate(late.id, at(0, 0), sql`current_date - 1`);
    await as(owner).tasks.create({ title: "Blocked", status: "BLOCKED" });

    expect(await recordDailySnapshots(db())).toBeGreaterThanOrEqual(1);
    expect(await recordDailySnapshots(db())).toBeGreaterThanOrEqual(1); // upsert, not duplicate
    const rows = await db().select().from(metricSnapshots).where(eq(metricSnapshots.orgId, org.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ openTasks: 2, overdueTasks: 1, blockedTasks: 1, pendingApprovals: 0 });

    // A snapshot recorded on the last day of last week is used as measured history.
    await db()
      .insert(metricSnapshots)
      .values({
        orgId: org.id,
        day: sql`(date_trunc('week', now()) - interval '1 day')::date` as unknown as string,
        openTasks: 9,
        overdueTasks: 7,
        blockedTasks: 0,
        pendingApprovals: 0,
      });
    const r = await as(owner).insights.trends();
    const lastWeek = r.weeks[r.weeks.length - 2]!;
    expect(lastWeek).toMatchObject({ overdue: 7, overdueSource: "measured" });
    expect(r.weeks[r.weeks.length - 3]!.overdueSource).toBe("reconstructed");
    // The current (partial) week is always live.
    expect(r.weeks[r.weeks.length - 1]).toMatchObject({ overdue: 1, overdueSource: "reconstructed" });
  });

  it("breaks tasks down by the assignee's department", async () => {
    const { owner, org, as } = await createOrg();
    const ops = await as(owner).departments.create({ name: "Operations" });
    const emp = await as(owner).employees.create({
      firstName: "Dee",
      lastName: "Partment",
      email: `dee-${Date.now()}@example.test`,
      departmentId: ops.id,
    });
    const t = await as(owner).tasks.create({ title: "Ops late", assigneeEmployeeId: emp.id });
    await backdate(t.id, at(0, 0), sql`current_date - 2`);
    await as(owner).tasks.create({ title: "Ops blocked", assigneeEmployeeId: emp.id, status: "BLOCKED" });
    await as(owner).tasks.create({ title: "Nobody's" });
    const done = await as(owner).tasks.create({ title: "Old done", assigneeEmployeeId: emp.id });
    await as(owner).tasks.update({ id: done.id, status: "DONE" });

    const r = await as(owner).insights.trends();
    const byName = Object.fromEntries(r.departments!.map((d) => [d.name ?? "none", d]));
    expect(byName.Operations).toMatchObject({ open: 2, overdue: 1, blocked: 1, completedRecent: 1 });
    expect(byName.none).toMatchObject({ open: 1, overdue: 0 });

    // Another organization's departments never appear.
    const other = await createOrg();
    const r2 = await other.as(other.owner).insights.trends();
    expect(r2.departments!.some((d) => d.name === "Operations")).toBe(false);
    void org;
  });
});
