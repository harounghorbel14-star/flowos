import { and, eq } from "drizzle-orm";
import type { Tx } from "../db/client";
import { departments, employees, memberships, projects } from "../db/schema";
import { badRequest } from "./errors";

/*
 * Reference validators. Every ID supplied by a client that points at another
 * record is checked here against the actor's organization before it is
 * written. Composite foreign keys enforce the same rule in the database;
 * these give a clear error message instead of a constraint violation.
 */

export async function requireDepartment(tx: Tx, orgId: string, id: string) {
  const [row] = await tx
    .select({ id: departments.id, name: departments.name })
    .from(departments)
    .where(and(eq(departments.orgId, orgId), eq(departments.id, id)))
    .limit(1);
  if (!row) throw badRequest("Department not found in this organization.");
  return row;
}

export async function requireEmployee(tx: Tx, orgId: string, id: string, what = "Employee") {
  const [row] = await tx
    .select({
      id: employees.id,
      userId: employees.userId,
      firstName: employees.firstName,
      lastName: employees.lastName,
      status: employees.status,
      managerId: employees.managerId,
    })
    .from(employees)
    .where(and(eq(employees.orgId, orgId), eq(employees.id, id)))
    .limit(1);
  if (!row) throw badRequest(`${what} not found in this organization.`);
  return row;
}

export async function requireProject(tx: Tx, orgId: string, id: string) {
  const [row] = await tx
    .select({ id: projects.id, name: projects.name, status: projects.status })
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.id, id)))
    .limit(1);
  if (!row) throw badRequest("Project not found in this organization.");
  return row;
}

export async function requireMember(tx: Tx, orgId: string, userId: string) {
  const [row] = await tx
    .select({ id: memberships.id, role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
    .limit(1);
  if (!row) throw badRequest("That user is not a member of this organization.");
  return row;
}

export const fullName = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`.trim();
