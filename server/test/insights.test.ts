import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
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
});
