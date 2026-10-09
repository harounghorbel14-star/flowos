import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { label, type ProjectStatus } from "@shared/domain";
import type { Database, Tx } from "../../db/client";
import { employees, projectMembers, projects, tasks } from "../../db/schema";
import { assertCan, type Actor } from "../../lib/actor";
import { audit, diff } from "../../lib/audit";
import { addDaysISO, todayISO } from "../../lib/dates";
import { badRequest, notFound } from "../../lib/errors";
import { likePattern, offsetOf, toPage, type PageInput } from "../../lib/pagination";
import { requireEmployee } from "../../lib/refs";
import { entityHistory } from "../audit/service";

export interface ProjectInput {
  name: string;
  description?: string | null;
  status?: ProjectStatus;
  ownerEmployeeId?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
}

export interface ProjectStats {
  total: number;
  done: number;
  blocked: number;
  overdue: number;
  progress: number;
}

/** Explicit, documented risk rules. Each reason is a measured fact, not a prediction. */
export const RISK_RULES = {
  dueSoonDays: 7,
  dueSoonProgressBelow: 0.7,
} as const;

export function riskReasons(
  project: { status: ProjectStatus; dueDate: string | null },
  stats: ProjectStats,
  today = todayISO(),
): string[] {
  if (project.status === "COMPLETED" || project.status === "CANCELLED") return [];
  const reasons: string[] = [];
  if (project.dueDate && project.dueDate < today) reasons.push(`Past due date (${project.dueDate})`);
  else if (
    project.dueDate &&
    project.dueDate <= addDaysISO(today, RISK_RULES.dueSoonDays) &&
    stats.total > 0 &&
    stats.progress < RISK_RULES.dueSoonProgressBelow
  ) {
    reasons.push(
      `Due ${project.dueDate} with ${Math.round(stats.progress * 100)}% of tasks done (rule: under ${
        RISK_RULES.dueSoonProgressBelow * 100
      }% within ${RISK_RULES.dueSoonDays} days)`,
    );
  }
  if (stats.overdue > 0) reasons.push(`${stats.overdue} overdue task${stats.overdue === 1 ? "" : "s"}`);
  if (stats.blocked > 0) reasons.push(`${stats.blocked} blocked task${stats.blocked === 1 ? "" : "s"}`);
  return reasons;
}

/** Per-project task statistics computed from actual task rows. */
export async function projectStats(
  db: Tx,
  orgId: string,
  projectIds: string[],
): Promise<Map<string, ProjectStats>> {
  const result = new Map<string, ProjectStats>();
  if (projectIds.length === 0) return result;
  const rows = await db
    .select({
      projectId: tasks.projectId,
      total: count(),
      done: sql<number>`count(*) filter (where ${tasks.status} = 'DONE')`.mapWith(Number),
      blocked: sql<number>`count(*) filter (where ${tasks.status} = 'BLOCKED')`.mapWith(Number),
      overdue:
        sql<number>`count(*) filter (where ${tasks.status} <> 'DONE' and ${tasks.dueDate} < current_date)`.mapWith(
          Number,
        ),
    })
    .from(tasks)
    .where(and(eq(tasks.orgId, orgId), inArray(tasks.projectId, projectIds)))
    .groupBy(tasks.projectId);
  for (const id of projectIds) result.set(id, { total: 0, done: 0, blocked: 0, overdue: 0, progress: 0 });
  for (const row of rows) {
    if (!row.projectId) continue;
    result.set(row.projectId, {
      total: row.total,
      done: row.done,
      blocked: row.blocked,
      overdue: row.overdue,
      progress: row.total === 0 ? 0 : row.done / row.total,
    });
  }
  return result;
}

const columns = {
  id: projects.id,
  name: projects.name,
  description: projects.description,
  status: projects.status,
  startDate: projects.startDate,
  dueDate: projects.dueDate,
  completedAt: projects.completedAt,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
  ownerEmployeeId: projects.ownerEmployeeId,
  ownerFirstName: employees.firstName,
  ownerLastName: employees.lastName,
};

export async function listProjects(
  db: Database,
  actor: Actor,
  input: PageInput & {
    search?: string;
    status?: ProjectStatus;
    ownerEmployeeId?: string;
    sort: "recent" | "due" | "name";
  },
) {
  assertCan(actor, "project:read");
  const filters: (SQL | undefined)[] = [eq(projects.orgId, actor.orgId)];
  if (input.search) {
    const p = likePattern(input.search);
    filters.push(or(ilike(projects.name, p), ilike(projects.description, p)));
  }
  if (input.status) filters.push(eq(projects.status, input.status));
  if (input.ownerEmployeeId) filters.push(eq(projects.ownerEmployeeId, input.ownerEmployeeId));
  const where = and(...filters);
  const order =
    input.sort === "due"
      ? [sql`${projects.dueDate} asc nulls last`]
      : input.sort === "name"
        ? [asc(projects.name)]
        : [desc(projects.updatedAt)];

  const [rows, [total]] = await Promise.all([
    db
      .select(columns)
      .from(projects)
      .leftJoin(
        employees,
        and(eq(employees.orgId, projects.orgId), eq(employees.id, projects.ownerEmployeeId)),
      )
      .where(where)
      .orderBy(...order)
      .limit(input.pageSize)
      .offset(offsetOf(input)),
    db.select({ n: count() }).from(projects).where(where),
  ]);
  const stats = await projectStats(
    db,
    actor.orgId,
    rows.map((r) => r.id),
  );
  const items = rows.map((r) => {
    const s = stats.get(r.id)!;
    return { ...r, stats: s, risk: riskReasons(r, s) };
  });
  return toPage(items, total?.n ?? 0, input);
}

export async function projectOptions(db: Database, actor: Actor) {
  assertCan(actor, "project:read");
  return db
    .select({ id: projects.id, name: projects.name, status: projects.status })
    .from(projects)
    .where(eq(projects.orgId, actor.orgId))
    .orderBy(asc(projects.name));
}

export async function getProject(db: Database, actor: Actor, id: string) {
  assertCan(actor, "project:read");
  const [project] = await db
    .select(columns)
    .from(projects)
    .leftJoin(employees, and(eq(employees.orgId, projects.orgId), eq(employees.id, projects.ownerEmployeeId)))
    .where(and(eq(projects.orgId, actor.orgId), eq(projects.id, id)))
    .limit(1);
  if (!project) throw notFound("Project");
  const [stats, members, history] = await Promise.all([
    projectStats(db, actor.orgId, [id]),
    db
      .select({
        id: employees.id,
        firstName: employees.firstName,
        lastName: employees.lastName,
        jobTitle: employees.jobTitle,
      })
      .from(projectMembers)
      .innerJoin(
        employees,
        and(eq(employees.orgId, projectMembers.orgId), eq(employees.id, projectMembers.employeeId)),
      )
      .where(and(eq(projectMembers.orgId, actor.orgId), eq(projectMembers.projectId, id)))
      .orderBy(asc(employees.firstName)),
    entityHistory(db, actor, "project", id, 30),
  ]);
  const s = stats.get(id)!;
  return { ...project, stats: s, risk: riskReasons(project, s), members, history };
}

async function validate(tx: Tx, actor: Actor, input: Partial<ProjectInput>, memberIds?: string[]) {
  if (input.ownerEmployeeId) {
    const owner = await requireEmployee(tx, actor.orgId, input.ownerEmployeeId, "Owner");
    if (owner.status === "TERMINATED") throw badRequest("A terminated employee cannot own a project.");
  }
  if (input.startDate && input.dueDate && input.dueDate < input.startDate) {
    throw badRequest("Due date cannot be before start date.");
  }
  for (const memberId of new Set(memberIds ?? []))
    await requireEmployee(tx, actor.orgId, memberId, "Project member");
}

async function replaceMembers(tx: Tx, orgId: string, projectId: string, memberIds: string[]) {
  await tx
    .delete(projectMembers)
    .where(and(eq(projectMembers.orgId, orgId), eq(projectMembers.projectId, projectId)));
  const unique = [...new Set(memberIds)];
  if (unique.length > 0) {
    await tx.insert(projectMembers).values(unique.map((employeeId) => ({ orgId, projectId, employeeId })));
  }
}

export async function createProject(
  db: Database,
  actor: Actor,
  input: ProjectInput & { memberIds?: string[] },
) {
  assertCan(actor, "project:write");
  const { memberIds = [], ...fields } = input;
  return db.transaction(async (tx) => {
    await validate(tx, actor, fields, memberIds);
    const [created] = await tx
      .insert(projects)
      .values({
        ...fields,
        orgId: actor.orgId,
        createdByUserId: actor.userId,
        completedAt: fields.status === "COMPLETED" ? new Date() : null,
      })
      .returning();
    await replaceMembers(tx, actor.orgId, created!.id, memberIds);
    await audit(tx, actor, {
      action: "project.created",
      entityType: "project",
      entityId: created!.id,
      summary: `Created project ${created!.name}`,
    });
    return created!;
  });
}

export async function updateProject(
  db: Database,
  actor: Actor,
  id: string,
  input: Partial<ProjectInput> & { memberIds?: string[] },
) {
  assertCan(actor, "project:write");
  const { memberIds, ...fields } = input;
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.orgId, actor.orgId), eq(projects.id, id)))
      .for("update");
    if (!before) throw notFound("Project");
    await validate(
      tx,
      actor,
      {
        ...fields,
        startDate: fields.startDate !== undefined ? fields.startDate : before.startDate,
        dueDate: fields.dueDate !== undefined ? fields.dueDate : before.dueDate,
      },
      memberIds,
    );
    let completedAt = before.completedAt;
    if (fields.status && fields.status !== before.status) {
      completedAt = fields.status === "COMPLETED" ? new Date() : null;
    }
    const [after] = await tx
      .update(projects)
      .set({ ...fields, completedAt, updatedAt: new Date() })
      .where(and(eq(projects.orgId, actor.orgId), eq(projects.id, id)))
      .returning();
    if (memberIds) await replaceMembers(tx, actor.orgId, id, memberIds);
    const statusChanged = fields.status && fields.status !== before.status;
    await audit(tx, actor, {
      action: statusChanged ? "project.status_changed" : "project.updated",
      entityType: "project",
      entityId: id,
      summary: statusChanged
        ? `Moved ${after!.name} to ${label(fields.status)}`
        : `Updated project ${after!.name}`,
      metadata: { ...diff(before, fields), ...(memberIds ? { memberIds } : {}) },
    });
    return after!;
  });
}

/** Projects can only be deleted while empty; otherwise complete or cancel them to keep history. */
export async function deleteProject(db: Database, actor: Actor, id: string) {
  assertCan(actor, "project:write");
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(eq(projects.orgId, actor.orgId), eq(projects.id, id)))
      .for("update");
    if (!project) throw notFound("Project");
    const [taskCount] = await tx
      .select({ n: count() })
      .from(tasks)
      .where(and(eq(tasks.orgId, actor.orgId), eq(tasks.projectId, id)));
    if ((taskCount?.n ?? 0) > 0) {
      throw badRequest("This project has tasks. Mark it completed or cancelled instead of deleting it.");
    }
    await tx.delete(projects).where(and(eq(projects.orgId, actor.orgId), eq(projects.id, id)));
    await audit(tx, actor, {
      action: "project.deleted",
      entityType: "project",
      entityId: id,
      summary: `Deleted project ${project.name}`,
    });
    return { ok: true };
  });
}
