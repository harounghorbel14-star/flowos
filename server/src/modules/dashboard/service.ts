import { and, asc, count, desc, eq, gte, inArray, lte, ne, notInArray, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import { approvalRequests, auditEvents, employees, projects, tasks, users } from "../../db/schema";
import { can, type Actor } from "../../lib/actor";
import { addDaysISO, todayISO } from "../../lib/dates";
import { myEmployee } from "../employees/service";
import { projectStats, riskReasons } from "../projects/service";
import { failureCount } from "../workflows/service";

/** Entity types whose activity every member may see. Others require audit:read. */
const SHARED_ACTIVITY = ["task", "project", "employee", "department"];
const PRIORITY_ORDER = sql`case ${tasks.priority} when 'URGENT' then 0 when 'HIGH' then 1 when 'MEDIUM' then 2 else 3 end`;

export interface BriefingLine {
  tone: "critical" | "attention" | "info" | "good";
  text: string;
  link?: string;
}

/**
 * The command center answers: what needs my attention, why, and what next.
 * Every number below is a direct count over the organization's records; the
 * briefing is rule-based text built from those counts (no AI involved).
 */
export async function commandCenter(db: Database, actor: Actor) {
  const today = todayISO();
  const weekAhead = addDaysISO(today, 7);
  const me = await myEmployee(db, actor);
  const canTasks = can(actor, "task:read");
  const canProjects = can(actor, "project:read");
  const openTask = and(eq(tasks.orgId, actor.orgId), ne(tasks.status, "DONE"));

  const taskCountsQ = canTasks
    ? db
        .select({
          open: count(),
          overdue: sql<number>`count(*) filter (where ${tasks.dueDate} < ${today})`.mapWith(Number),
          dueThisWeek:
            sql<number>`count(*) filter (where ${tasks.dueDate} between ${today} and ${weekAhead})`.mapWith(
              Number,
            ),
          blocked: sql<number>`count(*) filter (where ${tasks.status} = 'BLOCKED')`.mapWith(Number),
          urgent: sql<number>`count(*) filter (where ${tasks.priority} = 'URGENT')`.mapWith(Number),
          unassigned: sql<number>`count(*) filter (where ${tasks.assigneeEmployeeId} is null)`.mapWith(
            Number,
          ),
          mineOpen: me
            ? sql<number>`count(*) filter (where ${tasks.assigneeEmployeeId} = ${me.id})`.mapWith(Number)
            : sql<number>`0`.mapWith(Number),
          mineOverdue: me
            ? sql<number>`count(*) filter (where ${tasks.assigneeEmployeeId} = ${me.id} and ${tasks.dueDate} < ${today})`.mapWith(
                Number,
              )
            : sql<number>`0`.mapWith(Number),
        })
        .from(tasks)
        .where(openTask)
    : Promise.resolve([]);

  const completedThisWeekQ = canTasks
    ? db
        .select({ n: count() })
        .from(tasks)
        .where(
          and(
            eq(tasks.orgId, actor.orgId),
            eq(tasks.status, "DONE"),
            gte(tasks.completedAt, new Date(`${addDaysISO(today, -7)}T00:00:00Z`)),
          ),
        )
    : Promise.resolve([]);

  const myTasksQ =
    canTasks && me
      ? db
          .select({
            id: tasks.id,
            number: tasks.number,
            title: tasks.title,
            status: tasks.status,
            priority: tasks.priority,
            dueDate: tasks.dueDate,
            projectName: projects.name,
          })
          .from(tasks)
          .leftJoin(projects, and(eq(projects.orgId, tasks.orgId), eq(projects.id, tasks.projectId)))
          .where(and(openTask, eq(tasks.assigneeEmployeeId, me.id)))
          .orderBy(sql`${tasks.dueDate} asc nulls last`, PRIORITY_ORDER)
          .limit(8)
      : Promise.resolve([]);

  const deadlinesQ = canTasks
    ? db
        .select({
          id: tasks.id,
          title: tasks.title,
          dueDate: tasks.dueDate,
          priority: tasks.priority,
          status: tasks.status,
          assigneeFirstName: employees.firstName,
          assigneeLastName: employees.lastName,
        })
        .from(tasks)
        .leftJoin(
          employees,
          and(eq(employees.orgId, tasks.orgId), eq(employees.id, tasks.assigneeEmployeeId)),
        )
        .where(and(openTask, lte(tasks.dueDate, weekAhead)))
        .orderBy(asc(tasks.dueDate), PRIORITY_ORDER)
        .limit(8)
    : Promise.resolve([]);

  const approvalsQ = db
    .select({
      id: approvalRequests.id,
      title: approvalRequests.title,
      type: approvalRequests.type,
      createdAt: approvalRequests.createdAt,
      requesterName: users.name,
    })
    .from(approvalRequests)
    .innerJoin(users, eq(users.id, approvalRequests.requesterUserId))
    .where(
      and(
        eq(approvalRequests.orgId, actor.orgId),
        eq(approvalRequests.approverUserId, actor.userId),
        eq(approvalRequests.status, "PENDING"),
      ),
    )
    .orderBy(asc(approvalRequests.createdAt))
    .limit(6);

  const approvalCountsQ = db
    .select({
      awaitingMe:
        sql<number>`count(*) filter (where ${approvalRequests.approverUserId} = ${actor.userId})`.mapWith(
          Number,
        ),
      myOpenRequests:
        sql<number>`count(*) filter (where ${approvalRequests.requesterUserId} = ${actor.userId})`.mapWith(
          Number,
        ),
    })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.orgId, actor.orgId), eq(approvalRequests.status, "PENDING")));

  const projectsQ = canProjects
    ? db
        .select({ id: projects.id, name: projects.name, status: projects.status, dueDate: projects.dueDate })
        .from(projects)
        .where(and(eq(projects.orgId, actor.orgId), notInArray(projects.status, ["COMPLETED", "CANCELLED"])))
        .orderBy(sql`${projects.dueDate} asc nulls last`)
        .limit(200)
    : Promise.resolve([]);

  // Who is on approved leave today — only for people who manage employees.
  const onLeaveQ = can(actor, "employee:write")
    ? db
        .select({ id: approvalRequests.id, name: users.name, payload: approvalRequests.payload })
        .from(approvalRequests)
        .innerJoin(users, eq(users.id, approvalRequests.requesterUserId))
        .where(
          and(
            eq(approvalRequests.orgId, actor.orgId),
            eq(approvalRequests.type, "LEAVE"),
            eq(approvalRequests.status, "APPROVED"),
            sql`${approvalRequests.payload}->>'startDate' <= ${today}`,
            sql`${approvalRequests.payload}->>'endDate' >= ${today}`,
          ),
        )
        .limit(20)
    : Promise.resolve([]);

  const activityQ = db
    .select({
      id: auditEvents.id,
      summary: auditEvents.summary,
      entityType: auditEvents.entityType,
      entityId: auditEvents.entityId,
      createdAt: auditEvents.createdAt,
      actorName: users.name,
    })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .where(
      and(
        eq(auditEvents.orgId, actor.orgId),
        can(actor, "audit:read") ? undefined : inArray(auditEvents.entityType, SHARED_ACTIVITY),
        // Comments and sign-ins are noise in an operational feed.
        notInArray(auditEvents.action, ["task.commented", "task.comment_deleted"]),
      ),
    )
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(12);

  const totalsQ = db
    .select({
      employees:
        sql<number>`(select count(*) from ${employees} where ${employees.orgId} = ${actor.orgId} and ${employees.status} <> 'TERMINATED')`.mapWith(
          Number,
        ),
      projects:
        sql<number>`(select count(*) from ${projects} where ${projects.orgId} = ${actor.orgId})`.mapWith(
          Number,
        ),
      tasks: sql<number>`(select count(*) from ${tasks} where ${tasks.orgId} = ${actor.orgId})`.mapWith(
        Number,
      ),
    })
    .from(sql`(select 1) as one`);

  const workflowFailuresQ = can(actor, "workflow:read") ? failureCount(db, actor, 7) : Promise.resolve(0);

  const [
    taskCounts,
    completedThisWeek,
    myTasks,
    deadlines,
    approvals,
    approvalCounts,
    projectRows,
    onLeave,
    activity,
    totals,
    workflowFailures,
  ] = await Promise.all([
    taskCountsQ,
    completedThisWeekQ,
    myTasksQ,
    deadlinesQ,
    approvalsQ,
    approvalCountsQ,
    projectsQ,
    onLeaveQ,
    activityQ,
    totalsQ,
    workflowFailuresQ,
  ]);

  const stats = await projectStats(
    db,
    actor.orgId,
    projectRows.map((p) => p.id),
  );
  const projectsAtRisk = projectRows
    .map((p) => {
      const s = stats.get(p.id)!;
      return { ...p, progress: s.progress, totalTasks: s.total, reasons: riskReasons(p, s, today) };
    })
    .filter((p) => p.reasons.length > 0)
    .slice(0, 6);

  const t = taskCounts[0];
  const a = approvalCounts[0] ?? { awaitingMe: 0, myOpenRequests: 0 };
  const metrics = {
    openTasks: t?.open ?? 0,
    overdueTasks: t?.overdue ?? 0,
    dueThisWeek: t?.dueThisWeek ?? 0,
    blockedTasks: t?.blocked ?? 0,
    urgentTasks: t?.urgent ?? 0,
    unassignedTasks: t?.unassigned ?? 0,
    myOpenTasks: t?.mineOpen ?? 0,
    myOverdueTasks: t?.mineOverdue ?? 0,
    completedLast7Days: completedThisWeek[0]?.n ?? 0,
    approvalsAwaitingMe: a.awaitingMe,
    myOpenRequests: a.myOpenRequests,
    projectsAtRisk: projectsAtRisk.length,
    workflowFailures7d: workflowFailures,
  };

  return {
    generatedAt: new Date(),
    today,
    hasEmployeeProfile: Boolean(me),
    totals: totals[0] ?? { employees: 0, projects: 0, tasks: 0 },
    metrics,
    briefing: buildBriefing(metrics, Boolean(me)),
    myTasks,
    deadlines,
    approvals,
    projectsAtRisk,
    onLeaveToday: onLeave.map((l) => ({ id: l.id, name: l.name, endDate: String(l.payload.endDate ?? "") })),
    activity,
  };
}

export function buildBriefing(m: Record<string, number>, hasProfile: boolean): BriefingLine[] {
  const lines: BriefingLine[] = [];
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (m.approvalsAwaitingMe! > 0) {
    lines.push({
      tone: "attention",
      text: `${plural(m.approvalsAwaitingMe!, "request")} waiting for your decision.`,
      link: "/approvals",
    });
  }
  if (m.myOverdueTasks! > 0) {
    lines.push({
      tone: "critical",
      text: `${m.myOverdueTasks} of your tasks ${m.myOverdueTasks === 1 ? "is" : "are"} past due.`,
      link: "/tasks?view=mine&overdue=1",
    });
  }
  if (m.overdueTasks! > m.myOverdueTasks!) {
    lines.push({
      tone: "critical",
      text: `${plural(m.overdueTasks!, "task")} across the organization ${m.overdueTasks === 1 ? "is" : "are"} overdue.`,
      link: "/tasks?overdue=1",
    });
  }
  if (m.blockedTasks! > 0) {
    lines.push({
      tone: "attention",
      text: `${plural(m.blockedTasks!, "task")} ${m.blockedTasks === 1 ? "is" : "are"} blocked and may need someone to unblock ${m.blockedTasks === 1 ? "it" : "them"}.`,
      link: "/tasks?status=BLOCKED",
    });
  }
  if (m.projectsAtRisk! > 0) {
    lines.push({
      tone: "attention",
      text: `${plural(m.projectsAtRisk!, "project")} flagged at risk.`,
      link: "/projects",
    });
  }
  if (m.workflowFailures7d! > 0) {
    lines.push({
      tone: "critical",
      text: `${plural(m.workflowFailures7d!, "workflow run")} failed in the last 7 days and did not finish.`,
      link: "/workflows",
    });
  }
  if (m.unassignedTasks! > 0) {
    lines.push({
      tone: "info",
      text: `${plural(m.unassignedTasks!, "open task")} without an owner.`,
      link: "/tasks?unassigned=1",
    });
  }
  if (m.dueThisWeek! > 0) {
    lines.push({
      tone: "info",
      text: `${plural(m.dueThisWeek!, "task")} due in the next 7 days.`,
      link: "/tasks?sort=due",
    });
  }
  if (m.completedLast7Days! > 0) {
    lines.push({
      tone: "good",
      text: `${plural(m.completedLast7Days!, "task")} completed in the last 7 days.`,
    });
  }
  if (!hasProfile) {
    lines.push({
      tone: "info",
      text: "Your account is not linked to a directory profile, so no tasks can be assigned to you yet.",
      link: "/people",
    });
  }
  return lines;
}
