import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { addMember, createOrg, db } from "./helpers";

describe("employees and departments", () => {
  it("creates, searches, filters and paginates employees", async () => {
    const { owner, as } = await createOrg();
    const eng = await as(owner).departments.create({ name: "Engineering" });
    for (let i = 0; i < 7; i++) {
      await as(owner).employees.create({
        firstName: `Eng${i}`,
        lastName: "Person",
        email: `eng${i}-${randomUUID()}@example.test`,
        departmentId: eng.id,
        jobTitle: i === 3 ? "Staff Engineer" : "Engineer",
      });
    }
    const page1 = await as(owner).employees.list({ departmentId: eng.id, pageSize: 5 });
    expect(page1.total).toBe(7);
    expect(page1.items).toHaveLength(5);
    expect(page1.pageCount).toBe(2);
    const page2 = await as(owner).employees.list({ departmentId: eng.id, pageSize: 5, page: 2 });
    expect(page2.items).toHaveLength(2);

    const staff = await as(owner).employees.list({ search: "staff" });
    expect(staff.items.map((e) => e.firstName)).toEqual(["Eng3"]);

    // Wildcards in search text are treated literally.
    expect((await as(owner).employees.list({ search: "%" })).total).toBe(0);

    const departments = await as(owner).departments.list();
    expect(departments.find((d) => d.id === eng.id)?.employeeCount).toBe(7);
  });

  it("rejects duplicate emails within an org but allows them across orgs", async () => {
    const a = await createOrg();
    const b = await createOrg();
    const email = `dup-${randomUUID()}@example.test`;
    await a.as(a.owner).employees.create({ firstName: "A", lastName: "One", email });
    await expect(
      a.as(a.owner).employees.create({ firstName: "A", lastName: "Two", email: email.toUpperCase() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      b.as(b.owner).employees.create({ firstName: "B", lastName: "One", email }),
    ).resolves.toBeTruthy();
  });

  it("rejects cross-organization department, manager and account references", async () => {
    const a = await createOrg();
    const b = await createOrg();
    const bDept = await b.as(b.owner).departments.create({ name: "Secret Dept" });
    const bEmployee = await b.as(b.owner).employees.create({
      firstName: "Bob",
      lastName: "B",
      email: `b-${randomUUID()}@example.test`,
    });
    const base = { firstName: "X", lastName: "Y", email: `x-${randomUUID()}@example.test` };
    await expect(a.as(a.owner).employees.create({ ...base, departmentId: bDept.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(a.as(a.owner).employees.create({ ...base, managerId: bEmployee.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(a.as(a.owner).employees.create({ ...base, userId: b.owner.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("enforces cross-tenant integrity in the database even if the service is bypassed", async () => {
    const a = await createOrg();
    const b = await createOrg();
    const bDept = await b.as(b.owner).departments.create({ name: "Other" });
    await expect(
      db().execute(
        sql`insert into employees (org_id, first_name, last_name, email, department_id) values (${a.org.id}, 'x', 'y', ${`raw-${randomUUID()}@e.test`}, ${bDept.id})`,
      ),
    ).rejects.toThrow();
  });

  it("returns NOT_FOUND for another organization's employee IDs", async () => {
    const a = await createOrg();
    const b = await createOrg();
    const bEmployee = await b.as(b.owner).employees.create({
      firstName: "Hidden",
      lastName: "Person",
      email: `h-${randomUUID()}@example.test`,
    });
    await expect(a.as(a.owner).employees.get({ id: bEmployee.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      a.as(a.owner).employees.update({ id: bEmployee.id, jobTitle: "pwned" }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const unchanged = await b.as(b.owner).employees.get({ id: bEmployee.id });
    expect(unchanged.jobTitle).toBeNull();
  });

  it("prevents reporting cycles and self-management", async () => {
    const { owner, as } = await createOrg();
    const mk = (n: string) =>
      as(owner).employees.create({ firstName: n, lastName: "L", email: `${n}-${randomUUID()}@example.test` });
    const ceo = await mk("ceo");
    const vp = await as(owner).employees.create({
      firstName: "vp",
      lastName: "L",
      email: `vp-${randomUUID()}@example.test`,
      managerId: ceo.id,
    });
    const ic = await as(owner).employees.create({
      firstName: "ic",
      lastName: "L",
      email: `ic-${randomUUID()}@example.test`,
      managerId: vp.id,
    });
    await expect(as(owner).employees.update({ id: ceo.id, managerId: ic.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(as(owner).employees.update({ id: ceo.id, managerId: ceo.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const detail = await as(owner).employees.get({ id: vp.id });
    expect(detail.directReports.map((r) => r.id)).toEqual([ic.id]);
    expect(detail.managerId).toBe(ceo.id);
  });

  it("lets members read the directory but not change it", async () => {
    const { owner, org, as } = await createOrg();
    const member = await addMember(org.id, owner, "MEMBER");
    const viewer = await addMember(org.id, owner, "VIEWER");
    expect((await as(member).employees.list({})).total).toBeGreaterThan(0);
    await expect(
      as(member).employees.create({ firstName: "N", lastName: "O", email: `n-${randomUUID()}@example.test` }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(viewer).departments.create({ name: "Nope" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("records employee history and status changes", async () => {
    const { owner, as } = await createOrg();
    const e = await as(owner).employees.create({
      firstName: "Hist",
      lastName: "Ory",
      email: `h-${randomUUID()}@e.test`,
    });
    await as(owner).employees.update({ id: e.id, status: "ON_LEAVE" });
    const detail = await as(owner).employees.get({ id: e.id });
    expect(detail.history.map((h) => h.action)).toEqual(["employee.status_changed", "employee.created"]);
    expect(detail.status).toBe("ON_LEAVE");
  });

  it("deleting a department unassigns its employees", async () => {
    const { owner, as } = await createOrg();
    const d = await as(owner).departments.create({ name: "Temp" });
    const e = await as(owner).employees.create({
      firstName: "T",
      lastName: "E",
      email: `t-${randomUUID()}@e.test`,
      departmentId: d.id,
    });
    const res = await as(owner).departments.delete({ id: d.id });
    expect(res.unassignedEmployees).toBe(1);
    expect((await as(owner).employees.get({ id: e.id })).departmentId).toBeNull();
  });
});
