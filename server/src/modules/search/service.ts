import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import { approvalRequests, departments, employees, organizations, projects, tasks } from "../../db/schema";
import { can, type Actor } from "../../lib/actor";
import { likePattern } from "../../lib/pagination";

export interface SearchHit {
  kind: "employee" | "department" | "project" | "task" | "approval";
  id: string;
  title: string;
  subtitle: string | null;
  link: string;
}

/**
 * Permission-aware global search. Each module is only queried when the actor
 * holds its read permission, and approvals are restricted to the ones the
 * actor can see — results are filtered in SQL, never after the fact.
 * Ranking: prefix matches first, then most recently updated.
 */
export async function globalSearch(
  db: Database,
  actor: Actor,
  term: string,
  perKind = 5,
): Promise<SearchHit[]> {
  const q = term.trim();
  if (q.length < 2) return [];
  const p = likePattern(q);
  const prefix = `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const queries: Promise<SearchHit[]>[] = [];

  if (can(actor, "employee:read")) {
    const name = sql`${employees.firstName} || ' ' || ${employees.lastName}`;
    queries.push(
      db
        .select({
          id: employees.id,
          firstName: employees.firstName,
          lastName: employees.lastName,
          jobTitle: employees.jobTitle,
          email: employees.email,
        })
        .from(employees)
        .where(
          and(
            eq(employees.orgId, actor.orgId),
            or(ilike(name, p), ilike(employees.email, p), ilike(employees.jobTitle, p)),
          ),
        )
        .orderBy(sql`(${name} ilike ${prefix}) desc`, employees.firstName)
        .limit(perKind)
        .then((rows) =>
          rows.map((r) => ({
            kind: "employee" as const,
            id: r.id,
            title: `${r.firstName} ${r.lastName}`,
            subtitle: r.jobTitle ?? r.email,
            link: `/people/${r.id}`,
          })),
        ),
      db
        .select({ id: departments.id, name: departments.name })
        .from(departments)
        .where(and(eq(departments.orgId, actor.orgId), ilike(departments.name, p)))
        .limit(perKind)
        .then((rows) =>
          rows.map((r) => ({
            kind: "department" as const,
            id: r.id,
            title: r.name,
            subtitle: "Department",
            link: `/people?department=${r.id}`,
          })),
        ),
    );
  }
  if (can(actor, "project:read")) {
    queries.push(
      db
        .select({ id: projects.id, name: projects.name, status: projects.status })
        .from(projects)
        .where(
          and(eq(projects.orgId, actor.orgId), or(ilike(projects.name, p), ilike(projects.description, p))),
        )
        .orderBy(sql`(${projects.name} ilike ${prefix}) desc`, desc(projects.updatedAt))
        .limit(perKind)
        .then((rows) =>
          rows.map((r) => ({
            kind: "project" as const,
            id: r.id,
            title: r.name,
            subtitle: r.status,
            link: `/projects/${r.id}`,
          })),
        ),
    );
  }
  if (can(actor, "task:read")) {
    const keyMatch = /^(?:[a-z]{2,6}-)?(\d{1,9})$/i.exec(q);
    queries.push(
      db
        .select({
          id: tasks.id,
          number: tasks.number,
          title: tasks.title,
          status: tasks.status,
          prefix: organizations.taskPrefix,
        })
        .from(tasks)
        .innerJoin(organizations, eq(organizations.id, tasks.orgId))
        .where(
          and(
            eq(tasks.orgId, actor.orgId),
            or(ilike(tasks.title, p), keyMatch ? eq(tasks.number, Number(keyMatch[1])) : undefined),
          ),
        )
        .orderBy(sql`(${tasks.title} ilike ${prefix}) desc`, desc(tasks.updatedAt))
        .limit(perKind)
        .then((rows) =>
          rows.map((r) => ({
            kind: "task" as const,
            id: r.id,
            title: r.title,
            subtitle: `${r.prefix}-${r.number} · ${r.status}`,
            link: `/tasks/${r.id}`,
          })),
        ),
    );
  }
  const approvalVisibility = can(actor, "approval:read_all")
    ? undefined
    : or(
        eq(approvalRequests.requesterUserId, actor.userId),
        eq(approvalRequests.approverUserId, actor.userId),
      );
  queries.push(
    db
      .select({
        id: approvalRequests.id,
        title: approvalRequests.title,
        status: approvalRequests.status,
        type: approvalRequests.type,
      })
      .from(approvalRequests)
      .where(
        and(eq(approvalRequests.orgId, actor.orgId), ilike(approvalRequests.title, p), approvalVisibility),
      )
      .orderBy(desc(approvalRequests.createdAt))
      .limit(perKind)
      .then((rows) =>
        rows.map((r) => ({
          kind: "approval" as const,
          id: r.id,
          title: r.title,
          subtitle: `${r.type} · ${r.status}`,
          link: `/approvals/${r.id}`,
        })),
      ),
  );

  return (await Promise.all(queries)).flat();
}
