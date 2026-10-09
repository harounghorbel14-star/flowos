import { and, asc, count, desc, eq, ilike, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { label, type EmployeeStatus, type EmploymentType } from "@shared/domain";
import type { Database, Tx } from "../../db/client";
import { departments, employees, tasks, users } from "../../db/schema";
import { assertCan, type Actor } from "../../lib/actor";
import { audit, diff } from "../../lib/audit";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { likePattern, offsetOf, toPage, type PageInput } from "../../lib/pagination";
import { fullName, requireDepartment, requireEmployee, requireMember } from "../../lib/refs";
import { emit } from "../../lib/events";
import { entityHistory } from "../audit/service";

export interface EmployeeInput {
  firstName: string;
  lastName: string;
  email: string;
  jobTitle?: string | null;
  phone?: string | null;
  location?: string | null;
  departmentId?: string | null;
  managerId?: string | null;
  userId?: string | null;
  status?: EmployeeStatus;
  employmentType?: EmploymentType;
  startDate?: string | null;
  endDate?: string | null;
}

export interface EmployeeListInput extends PageInput {
  search?: string;
  departmentId?: string;
  status?: EmployeeStatus;
  managerId?: string;
  sort: "name" | "recent" | "startDate";
}

const manager = alias(employees, "manager");

const listColumns = {
  id: employees.id,
  firstName: employees.firstName,
  lastName: employees.lastName,
  email: employees.email,
  jobTitle: employees.jobTitle,
  status: employees.status,
  employmentType: employees.employmentType,
  startDate: employees.startDate,
  userId: employees.userId,
  departmentId: employees.departmentId,
  departmentName: departments.name,
  managerId: employees.managerId,
  managerFirstName: manager.firstName,
  managerLastName: manager.lastName,
};

export async function listEmployees(db: Database, actor: Actor, input: EmployeeListInput) {
  assertCan(actor, "employee:read");
  const filters: (SQL | undefined)[] = [eq(employees.orgId, actor.orgId)];
  if (input.search) {
    const p = likePattern(input.search);
    filters.push(
      or(
        ilike(employees.firstName, p),
        ilike(employees.lastName, p),
        ilike(sql`${employees.firstName} || ' ' || ${employees.lastName}`, p),
        ilike(employees.email, p),
        ilike(employees.jobTitle, p),
      ),
    );
  }
  if (input.departmentId) filters.push(eq(employees.departmentId, input.departmentId));
  if (input.status) filters.push(eq(employees.status, input.status));
  if (input.managerId) filters.push(eq(employees.managerId, input.managerId));
  const where = and(...filters);

  const order =
    input.sort === "recent"
      ? [desc(employees.createdAt)]
      : input.sort === "startDate"
        ? [sql`${employees.startDate} desc nulls last`, asc(employees.lastName)]
        : [asc(employees.lastName), asc(employees.firstName)];

  const [items, [total]] = await Promise.all([
    db
      .select(listColumns)
      .from(employees)
      .leftJoin(
        departments,
        and(eq(departments.orgId, employees.orgId), eq(departments.id, employees.departmentId)),
      )
      .leftJoin(manager, and(eq(manager.orgId, employees.orgId), eq(manager.id, employees.managerId)))
      .where(where)
      .orderBy(...order)
      .limit(input.pageSize)
      .offset(offsetOf(input)),
    db.select({ n: count() }).from(employees).where(where),
  ]);
  return toPage(items, total?.n ?? 0, input);
}

/** Lightweight list for pickers (assignees, managers, owners). */
export async function employeeOptions(db: Database, actor: Actor, includeTerminated = false) {
  assertCan(actor, "employee:read");
  return db
    .select({
      id: employees.id,
      firstName: employees.firstName,
      lastName: employees.lastName,
      jobTitle: employees.jobTitle,
      status: employees.status,
      userId: employees.userId,
    })
    .from(employees)
    .where(
      and(
        eq(employees.orgId, actor.orgId),
        includeTerminated ? undefined : ne(employees.status, "TERMINATED"),
      ),
    )
    .orderBy(asc(employees.firstName), asc(employees.lastName));
}

export async function getEmployee(db: Database, actor: Actor, id: string) {
  assertCan(actor, "employee:read");
  const [employee] = await db
    .select({
      ...listColumns,
      phone: employees.phone,
      location: employees.location,
      endDate: employees.endDate,
      createdAt: employees.createdAt,
      updatedAt: employees.updatedAt,
      accountName: users.name,
      accountEmail: users.email,
    })
    .from(employees)
    .leftJoin(
      departments,
      and(eq(departments.orgId, employees.orgId), eq(departments.id, employees.departmentId)),
    )
    .leftJoin(manager, and(eq(manager.orgId, employees.orgId), eq(manager.id, employees.managerId)))
    .leftJoin(users, eq(users.id, employees.userId))
    .where(and(eq(employees.orgId, actor.orgId), eq(employees.id, id)))
    .limit(1);
  if (!employee) throw notFound("Employee");

  const [directReports, taskStats, history] = await Promise.all([
    db
      .select({
        id: employees.id,
        firstName: employees.firstName,
        lastName: employees.lastName,
        jobTitle: employees.jobTitle,
      })
      .from(employees)
      .where(and(eq(employees.orgId, actor.orgId), eq(employees.managerId, id)))
      .orderBy(asc(employees.firstName)),
    db
      .select({
        open: sql<number>`count(*) filter (where ${tasks.status} <> 'DONE')`.mapWith(Number),
        overdue:
          sql<number>`count(*) filter (where ${tasks.status} <> 'DONE' and ${tasks.dueDate} < current_date)`.mapWith(
            Number,
          ),
        done: sql<number>`count(*) filter (where ${tasks.status} = 'DONE')`.mapWith(Number),
      })
      .from(tasks)
      .where(and(eq(tasks.orgId, actor.orgId), eq(tasks.assigneeEmployeeId, id))),
    entityHistory(db, actor, "employee", id, 30),
  ]);
  return { ...employee, directReports, taskStats: taskStats[0] ?? { open: 0, overdue: 0, done: 0 }, history };
}

/** Reject a manager assignment that would create a reporting cycle. */
async function assertNoManagerCycle(tx: Tx, orgId: string, employeeId: string, managerId: string) {
  let current: string | null = managerId;
  for (let depth = 0; current && depth < 50; depth++) {
    if (current === employeeId) throw badRequest("That manager would create a reporting cycle.");
    const next: { managerId: string | null } = await requireEmployee(tx, orgId, current, "Manager");
    current = next.managerId;
  }
}

async function validateReferences(tx: Tx, actor: Actor, input: Partial<EmployeeInput>, employeeId?: string) {
  if (input.departmentId) await requireDepartment(tx, actor.orgId, input.departmentId);
  if (input.managerId) {
    const mgr = await requireEmployee(tx, actor.orgId, input.managerId, "Manager");
    if (mgr.status === "TERMINATED") throw badRequest("A terminated employee cannot be a manager.");
    if (employeeId) await assertNoManagerCycle(tx, actor.orgId, employeeId, input.managerId);
  }
  if (input.userId) {
    await requireMember(tx, actor.orgId, input.userId);
    const [linked] = await tx
      .select({ id: employees.id })
      .from(employees)
      .where(and(eq(employees.orgId, actor.orgId), eq(employees.userId, input.userId)))
      .limit(1);
    if (linked && linked.id !== employeeId)
      throw conflict("That account is already linked to another employee.");
  }
  if (input.startDate && input.endDate && input.endDate < input.startDate) {
    throw badRequest("End date cannot be before start date.");
  }
}

async function assertEmailFree(tx: Tx, orgId: string, email: string, exceptId?: string) {
  const [row] = await tx
    .select({ id: employees.id })
    .from(employees)
    .where(and(eq(employees.orgId, orgId), eq(sql`lower(${employees.email})`, email.toLowerCase())))
    .limit(1);
  if (row && row.id !== exceptId) throw conflict("An employee with that email already exists.");
}

export async function createEmployee(db: Tx, actor: Actor, input: EmployeeInput) {
  assertCan(actor, "employee:write");
  return db.transaction(async (tx) => {
    await assertEmailFree(tx, actor.orgId, input.email);
    await validateReferences(tx, actor, input);
    const [created] = await tx
      .insert(employees)
      .values({ ...input, email: input.email.toLowerCase(), orgId: actor.orgId })
      .returning();
    await audit(tx, actor, {
      action: "employee.created",
      entityType: "employee",
      entityId: created!.id,
      summary: `Added ${fullName(created!)} to the directory`,
    });
    const dept = created!.departmentId
      ? await requireDepartment(tx, actor.orgId, created!.departmentId)
      : null;
    await emit(tx, actor, "employee.created", created!.id, {
      employeeId: created!.id,
      firstName: created!.firstName,
      lastName: created!.lastName,
      email: created!.email,
      jobTitle: created!.jobTitle,
      status: created!.status,
      employmentType: created!.employmentType,
      departmentName: dept?.name ?? null,
      startDate: created!.startDate,
      subjectEmployeeId: created!.id,
      subjectUserId: created!.userId,
    });
    return created!;
  });
}

export async function updateEmployee(db: Database, actor: Actor, id: string, input: Partial<EmployeeInput>) {
  assertCan(actor, "employee:write");
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(employees)
      .where(and(eq(employees.orgId, actor.orgId), eq(employees.id, id)))
      .for("update");
    if (!before) throw notFound("Employee");
    if (input.email) await assertEmailFree(tx, actor.orgId, input.email, id);
    if (input.managerId === id) throw badRequest("An employee cannot manage themselves.");
    await validateReferences(
      tx,
      actor,
      {
        ...input,
        startDate: input.startDate !== undefined ? input.startDate : before.startDate,
        endDate: input.endDate !== undefined ? input.endDate : before.endDate,
      },
      id,
    );
    const patch = { ...input, ...(input.email ? { email: input.email.toLowerCase() } : {}) };
    const [after] = await tx
      .update(employees)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(employees.orgId, actor.orgId), eq(employees.id, id)))
      .returning();
    const statusChanged = input.status && input.status !== before.status;
    await audit(tx, actor, {
      action: statusChanged ? "employee.status_changed" : "employee.updated",
      entityType: "employee",
      entityId: id,
      summary: statusChanged
        ? `Changed ${fullName(after!)}'s status to ${label(input.status)}`
        : `Updated ${fullName(after!)}'s profile`,
      metadata: diff(before, patch),
    });
    return after!;
  });
}

/** Employee record linked to the actor's own account in this organization, if any. */
export async function myEmployee(db: Database, actor: Actor) {
  const [row] = await db
    .select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName })
    .from(employees)
    .where(and(eq(employees.orgId, actor.orgId), eq(employees.userId, actor.userId)))
    .limit(1);
  return row ?? null;
}
