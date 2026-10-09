import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addDaysISO, todayISO } from "../src/lib/dates";
import { addMember, createOrg } from "./helpers";

describe("command center", () => {
  it("returns honest zeros for an empty organization", async () => {
    const { owner, as } = await createOrg();
    const cc = await as(owner).dashboard.commandCenter();
    expect(cc.metrics).toMatchObject({
      openTasks: 0,
      overdueTasks: 0,
      approvalsAwaitingMe: 0,
      projectsAtRisk: 0,
    });
    expect(cc.totals).toMatchObject({ projects: 0, tasks: 0, employees: 1 });
    expect(cc.myTasks).toEqual([]);
    expect(cc.briefing).toEqual([]);
  });

  it("reflects real overdue, blocked and approval data", async () => {
    const { owner, org, as } = await createOrg();
    const me = (await as(owner).employees.me())!;
    const member = await addMember(org.id, owner, "MEMBER");
    await as(owner).tasks.create({
      title: "late",
      assigneeEmployeeId: me.id,
      dueDate: addDaysISO(todayISO(), -2),
    });
    await as(owner).tasks.create({ title: "stuck", status: "BLOCKED" });
    const done = await as(owner).tasks.create({ title: "finished" });
    await as(owner).tasks.update({ id: done.id, status: "DONE" });
    await as(member).approvals.create({ type: "GENERAL", title: "Approve me", approverUserId: owner.id });

    const cc = await as(owner).dashboard.commandCenter();
    expect(cc.metrics).toMatchObject({
      openTasks: 2,
      overdueTasks: 1,
      myOverdueTasks: 1,
      blockedTasks: 1,
      unassignedTasks: 1,
      completedLast7Days: 1,
      approvalsAwaitingMe: 1,
    });
    expect(cc.myTasks.map((t) => t.title)).toEqual(["late"]);
    expect(cc.approvals.map((a) => a.title)).toEqual(["Approve me"]);
    const text = cc.briefing.map((b) => b.text).join("\n");
    expect(text).toContain("1 request waiting for your decision.");
    expect(text).toContain("1 of your tasks is past due.");
    expect(text).toContain("1 task is blocked");
  });

  it("does not leak private activity to regular members", async () => {
    const { owner, org, as } = await createOrg();
    const member = await addMember(org.id, owner, "MEMBER");
    await as(owner).orgs.invite({ email: `secret-${randomUUID()}@e.test`, role: "ADMIN" });
    const memberFeed = await as(member).dashboard.commandCenter();
    expect(
      memberFeed.activity.every((a) => ["task", "project", "employee", "department"].includes(a.entityType)),
    ).toBe(true);
    const ownerFeed = await as(owner).dashboard.commandCenter();
    expect(ownerFeed.activity.some((a) => a.entityType === "invitation")).toBe(true);
  });
});

describe("global search", () => {
  it("finds records across modules within the tenant only", async () => {
    const a = await createOrg();
    const b = await createOrg();
    await a.as(a.owner).projects.create({ name: "Orion launch" });
    await a.as(a.owner).tasks.create({ title: "Orion checklist" });
    await b.as(b.owner).projects.create({ name: "Orion competitor plan" });
    const hits = await a.as(a.owner).search.global({ q: "orion" });
    expect(hits.map((h) => h.kind).sort()).toEqual(["project", "task"]);
    expect(hits.some((h) => h.title.includes("competitor"))).toBe(false);
  });

  it("filters approvals the searcher cannot see", async () => {
    const { owner, org, as } = await createOrg();
    const requester = await addMember(org.id, owner, "MEMBER");
    const bystander = await addMember(org.id, owner, "MEMBER");
    await as(requester).approvals.create({
      type: "HR",
      title: "Salary review",
      approverUserId: owner.id,
      payload: { category: "Pay" },
    });
    expect((await as(owner).search.global({ q: "salary" })).length).toBe(1);
    expect((await as(requester).search.global({ q: "salary" })).length).toBe(1);
    expect((await as(bystander).search.global({ q: "salary" })).length).toBe(0);
  });

  it("ignores too-short queries", async () => {
    const { owner, as } = await createOrg();
    expect(await as(owner).search.global({ q: "a" })).toEqual([]);
  });
});
