import { and, asc, count, eq, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import { departments, employees } from "../../db/schema";
import { assertCan, type Actor } from "../../lib/actor";
import { audit, diff } from "../../lib/audit";
import { conflict, notFound } from "../../lib/errors";

export async function listDepartments(db: Database, actor: Actor) {
  assertCan(actor, "employee:read");
  return db
    .select({
      id: departments.id,
      name: departments.name,
      description: departments.description,
      employeeCount:
        sql<number>`count(${employees.id}) filter (where ${employees.status} <> 'TERMINATED')`.mapWith(
          Number,
        ),
    })
    .from(departments)
    .leftJoin(
      employees,
      and(eq(employees.orgId, departments.orgId), eq(employees.departmentId, departments.id)),
    )
    .where(eq(departments.orgId, actor.orgId))
    .groupBy(departments.id)
    .orderBy(asc(departments.name));
}

async function assertNameFree(db: Database, orgId: string, name: string, exceptId?: string) {
  const [row] = await db
    .select({ id: departments.id })
    .from(departments)
    .where(and(eq(departments.orgId, orgId), eq(sql`lower(${departments.name})`, name.toLowerCase())))
    .limit(1);
  if (row && row.id !== exceptId) throw conflict("A department with that name already exists.");
}

export async function createDepartment(
  db: Database,
  actor: Actor,
  input: { name: string; description?: string | null },
) {
  assertCan(actor, "department:write");
  await assertNameFree(db, actor.orgId, input.name);
  return db.transaction(async (tx) => {
    const [dept] = await tx
      .insert(departments)
      .values({ orgId: actor.orgId, name: input.name, description: input.description ?? null })
      .returning();
    await audit(tx, actor, {
      action: "department.created",
      entityType: "department",
      entityId: dept!.id,
      summary: `Created department ${dept!.name}`,
    });
    return dept!;
  });
}

export async function updateDepartment(
  db: Database,
  actor: Actor,
  id: string,
  input: { name?: string; description?: string | null },
) {
  assertCan(actor, "department:write");
  if (input.name) await assertNameFree(db, actor.orgId, input.name, id);
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(departments)
      .where(and(eq(departments.orgId, actor.orgId), eq(departments.id, id)))
      .for("update");
    if (!before) throw notFound("Department");
    const [after] = await tx
      .update(departments)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(departments.orgId, actor.orgId), eq(departments.id, id)))
      .returning();
    await audit(tx, actor, {
      action: "department.updated",
      entityType: "department",
      entityId: id,
      summary: `Updated department ${after!.name}`,
      metadata: diff(before, input),
    });
    return after!;
  });
}

export async function deleteDepartment(db: Database, actor: Actor, id: string) {
  assertCan(actor, "department:write");
  return db.transaction(async (tx) => {
    const [members] = await tx
      .select({ n: count() })
      .from(employees)
      .where(and(eq(employees.orgId, actor.orgId), eq(employees.departmentId, id)));
    const [deleted] = await tx
      .delete(departments)
      .where(and(eq(departments.orgId, actor.orgId), eq(departments.id, id)))
      .returning({ id: departments.id, name: departments.name });
    if (!deleted) throw notFound("Department");
    await audit(tx, actor, {
      action: "department.deleted",
      entityType: "department",
      entityId: id,
      summary: `Deleted department ${deleted.name}`,
      metadata: { unassignedEmployees: members?.n ?? 0 },
    });
    return { ok: true, unassignedEmployees: members?.n ?? 0 };
  });
}
