import { label, type TaskPriority } from "@shared/domain";
import type { Database } from "../../db/client";
import { can, type Actor } from "../../lib/actor";
import { addDaysISO, todayISO } from "../../lib/dates";
import { listRequests } from "../approvals/service";
import { myEmployee } from "../employees/service";
import { getProject, listProjects } from "../projects/service";
import { listTasks } from "../tasks/service";

/**
 * FLOWOS-owned operational analysis. Every figure comes from records read
 * through the regular services with the requesting user's permissions; every
 * ranking uses the documented rules below, and every result names its
 * evidence and what it could not know. No language model is involved.
 */

export interface Evidence {
  kind: "task" | "project" | "approval";
  id: string;
  label: string;
  link: string;
}

export interface RankedItem {
  kind: "task" | "approval" | "project";
  id: string;
  title: string;
  link: string;
  score: number;
  reasons: string[];
  dueDate?: string | null;
  status?: string;
  priority?: string;
  owner?: string | null;
}

/** The scoring rules, shown to users so a ranking can be checked by hand. */
export const PRIORITY_RULES = {
  priorityPoints: { URGENT: 40, HIGH: 25, MEDIUM: 10, LOW: 0 } satisfies Record<TaskPriority, number>,
  overdueBase: 30,
  overduePerDay: 2,
  overdueCap: 30,
  dueToday: 25,
  dueWithin3Days: 15,
  dueWithin7Days: 5,
  blocked: 10,
  approvalBase: 30,
  approvalPerDayWaiting: 3,
  approvalCap: 30,
  projectAtRiskBase: 20,
  projectPerRiskReason: 5,
} as const;

export const RULES_TEXT = [
  "Tasks: priority (Urgent 40, High 25, Medium 10, Low 0); overdue +30 and +2 per day late (max +30); due today +25, within 3 days +15, within 7 days +5; blocked +10.",
  "Approvals waiting for your decision: 30, +3 per day waiting (max +30): someone is waiting on you.",
  "Projects you own with explicit risk reasons: 20, +5 per reason.",
];

const person = (f?: string | null, l?: string | null) => [f, l].filter(Boolean).join(" ") || null;

export function daysBetween(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86_400_000);
}

export function scoreTask(
  t: { priority: TaskPriority; status: string; dueDate: string | null },
  today = todayISO(),
): { score: number; reasons: string[] } {
  const r = PRIORITY_RULES;
  let score = r.priorityPoints[t.priority];
  const reasons: string[] = [];
  if (t.priority === "URGENT" || t.priority === "HIGH") reasons.push(`${label(t.priority)} priority`);
  if (t.dueDate) {
    const late = daysBetween(t.dueDate, today);
    if (late > 0) {
      score += r.overdueBase + Math.min(r.overdueCap, late * r.overduePerDay);
      reasons.push(`${late} day${late === 1 ? "" : "s"} overdue (due ${t.dueDate})`);
    } else if (late === 0) {
      score += r.dueToday;
      reasons.push("Due today");
    } else if (late >= -3) {
      score += r.dueWithin3Days;
      reasons.push(`Due ${t.dueDate}`);
    } else if (late >= -7) {
      score += r.dueWithin7Days;
      reasons.push(`Due ${t.dueDate}`);
    }
  }
  if (t.status === "BLOCKED") {
    score += r.blocked;
    reasons.push("Blocked: needs unblocking");
  }
  return { score, reasons };
}

const OPEN = ["TODO", "IN_PROGRESS", "BLOCKED", "REVIEW"] as const;

/** What this person should look at first today, across tasks, approvals and their projects. */
export async function prioritize(db: Database, actor: Actor, limit = 10) {
  const today = todayISO();
  const notes: string[] = [];
  const items: RankedItem[] = [];
  const me = await myEmployee(db, actor);
  if (!me) notes.push("You have no linked employee profile, so no tasks can be assigned to you.");

  if (can(actor, "task:read") && me) {
    const mine = await listTasks(db, actor, {
      page: 1,
      pageSize: 100,
      mine: true,
      statuses: [...OPEN],
      sort: "due",
    });
    if (mine.total > mine.items.length)
      notes.push(`Only your first ${mine.items.length} open tasks were ranked.`);
    const undated = mine.items.filter((t) => !t.dueDate).length;
    if (undated > 0)
      notes.push(`${undated} of your open tasks have no due date, so they rank on priority alone.`);
    for (const t of mine.items) {
      const { score, reasons } = scoreTask(t, today);
      items.push({
        kind: "task",
        id: t.id,
        title: `#${t.number} ${t.title}`,
        link: `/tasks/${t.id}`,
        score,
        reasons: reasons.length ? reasons : [`${label(t.priority)} priority, no deadline pressure`],
        dueDate: t.dueDate,
        status: t.status,
        priority: t.priority,
        owner: person(t.assigneeFirstName, t.assigneeLastName),
      });
    }
  }

  const inbox = await listRequests(db, actor, { page: 1, pageSize: 50, box: "inbox", status: "PENDING" });
  for (const a of inbox.items) {
    const waiting = Math.max(0, daysBetween(todayISO(a.createdAt), today));
    const r = PRIORITY_RULES;
    items.push({
      kind: "approval",
      id: a.id,
      title: a.title,
      link: `/approvals/${a.id}`,
      score: r.approvalBase + Math.min(r.approvalCap, waiting * r.approvalPerDayWaiting),
      reasons: [
        `${a.requesterName} is waiting for your decision`,
        waiting > 0 ? `waiting ${waiting} day${waiting === 1 ? "" : "s"}` : "submitted today",
      ],
      status: a.status,
      owner: a.requesterName,
    });
  }

  if (can(actor, "project:read") && me) {
    const owned = await listProjects(db, actor, {
      page: 1,
      pageSize: 50,
      ownerEmployeeId: me.id,
      sort: "due",
    });
    for (const p of owned.items) {
      if (p.risk.length === 0) continue;
      items.push({
        kind: "project",
        id: p.id,
        title: p.name,
        link: `/projects/${p.id}`,
        score: PRIORITY_RULES.projectAtRiskBase + PRIORITY_RULES.projectPerRiskReason * p.risk.length,
        reasons: p.risk,
        dueDate: p.dueDate,
        status: p.status,
      });
    }
  }

  items.sort((a, b) => b.score - a.score || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
  return { today, rules: RULES_TEXT, items: items.slice(0, limit), considered: items.length, notes };
}

const PRIORITY_WEIGHT: Record<TaskPriority, number> = { URGENT: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

/** Open tasks past their due date, most urgent first: priority weight × 10 + days late (max 60). */
export async function overdueTasks(
  db: Database,
  actor: Actor,
  opts: { mine?: boolean; limit?: number } = {},
) {
  const today = todayISO();
  const page = await listTasks(db, actor, {
    page: 1,
    pageSize: 100,
    overdue: true,
    mine: opts.mine,
    sort: "due",
  });
  const ranked = page.items
    .map((t) => {
      const late = daysBetween(t.dueDate!, today);
      const reasons = [
        `${late} day${late === 1 ? "" : "s"} overdue (due ${t.dueDate})`,
        `${label(t.priority)} priority`,
      ];
      if (!t.assigneeEmployeeId) reasons.push("Unassigned: nobody owns it");
      if (t.status === "BLOCKED") reasons.push("Blocked");
      return {
        kind: "task" as const,
        id: t.id,
        title: `#${t.number} ${t.title}`,
        link: `/tasks/${t.id}`,
        score: PRIORITY_WEIGHT[t.priority] * 10 + Math.min(60, late) + (t.assigneeEmployeeId ? 0 : 5),
        reasons,
        dueDate: t.dueDate,
        status: t.status,
        priority: t.priority,
        owner: person(t.assigneeFirstName, t.assigneeLastName),
        project: t.projectName,
      };
    })
    .sort((a, b) => b.score - a.score);
  const notes: string[] = [];
  if (page.total > page.items.length)
    notes.push(`Ranked the ${page.items.length} earliest-due of ${page.total} overdue tasks.`);
  return {
    today,
    rule: "Urgency = priority weight (Urgent 4, High 3, Medium 2, Low 1) × 10 + days overdue (max 60), +5 if unassigned.",
    total: page.total,
    items: ranked.slice(0, opts.limit ?? 10),
    notes,
  };
}

/**
 * Projects that appear blocked. FLOWOS has no task-dependency data, so "blocked" means
 * evidence people recorded: tasks marked Blocked, a project put On hold, or overdue work.
 */
export async function blockedWork(db: Database, actor: Actor) {
  const [projectsPage, blockedTasks] = await Promise.all([
    listProjects(db, actor, { page: 1, pageSize: 100, sort: "due" }),
    listTasks(db, actor, { page: 1, pageSize: 100, statuses: ["BLOCKED"], sort: "due" }),
  ]);
  const byProject = new Map<string, typeof blockedTasks.items>();
  for (const t of blockedTasks.items) {
    if (!t.projectId) continue;
    byProject.set(t.projectId, [...(byProject.get(t.projectId) ?? []), t]);
  }
  const projects = projectsPage.items
    .filter((p) => p.status !== "COMPLETED" && p.status !== "CANCELLED")
    .map((p) => {
      const signals: string[] = [];
      if (p.stats.blocked > 0)
        signals.push(`${p.stats.blocked} task${p.stats.blocked === 1 ? "" : "s"} marked Blocked`);
      if (p.status === "ON_HOLD") signals.push("Project is On hold");
      if (p.stats.overdue > 0)
        signals.push(`${p.stats.overdue} overdue task${p.stats.overdue === 1 ? "" : "s"}`);
      if (p.dueDate && p.dueDate < todayISO()) signals.push(`Past its due date (${p.dueDate})`);
      return {
        projectId: p.id,
        name: p.name,
        link: `/projects/${p.id}`,
        status: p.status,
        owner: person(p.ownerFirstName, p.ownerLastName),
        progress: Math.round(p.stats.progress * 100),
        signals,
        // Blocked tasks or an on-hold status are direct evidence; overdue work alone is a weaker sign.
        appearsBlocked: p.stats.blocked > 0 || p.status === "ON_HOLD",
        blockedTasks: (byProject.get(p.id) ?? []).slice(0, 10).map((t) => ({
          taskId: t.id,
          title: `#${t.number} ${t.title}`,
          assignee: person(t.assigneeFirstName, t.assigneeLastName),
          dueDate: t.dueDate,
          link: `/tasks/${t.id}`,
        })),
      };
    })
    .filter((p) => p.signals.length > 0)
    .sort(
      (a, b) => Number(b.appearsBlocked) - Number(a.appearsBlocked) || b.signals.length - a.signals.length,
    );
  const unprojectedBlocked = blockedTasks.items.filter((t) => !t.projectId).length;
  const notes = [
    "FLOWOS records no dependencies between tasks; “blocked” is based on tasks people marked Blocked and projects put On hold.",
  ];
  if (projectsPage.total > projectsPage.items.length)
    notes.push(`Checked the first ${projectsPage.items.length} of ${projectsPage.total} projects.`);
  if (unprojectedBlocked > 0)
    notes.push(
      `${unprojectedBlocked} blocked task${unprojectedBlocked === 1 ? " is" : "s are"} not in any project.`,
    );
  return { projects, blockedTaskCount: blockedTasks.total, notes };
}

export interface SuggestedStep {
  text: string;
  evidence: Evidence[];
  /** A change the engine can prepare for confirmation, when one fits. */
  proposal?: { tool: "create_task" | "update_task_status"; input: Record<string, unknown> };
}

/** Rule-based next steps for one project, each tied to the records that triggered it. */
export async function resolutionSteps(db: Database, actor: Actor, projectId: string) {
  const today = todayISO();
  const project = await getProject(db, actor, projectId);
  const page = await listTasks(db, actor, { page: 1, pageSize: 100, projectId, sort: "due" });
  const open = page.items.filter((t) => t.status !== "DONE");
  const ev = (t: (typeof open)[number]): Evidence => ({
    kind: "task",
    id: t.id,
    label: `#${t.number} ${t.title}`,
    link: `/tasks/${t.id}`,
  });
  const steps: SuggestedStep[] = [];
  for (const t of open.filter((t) => t.status === "BLOCKED")) {
    const who = person(t.assigneeFirstName, t.assigneeLastName);
    steps.push({
      text: who
        ? `Ask ${who} what is blocking #${t.number} “${t.title}” and record it in a comment.`
        : `#${t.number} “${t.title}” is blocked and unassigned: give it an owner who can unblock it.`,
      evidence: [ev(t)],
      proposal: {
        tool: "create_task",
        input: {
          title: `Unblock #${t.number}: ${t.title}`.slice(0, 200),
          priority: "HIGH",
          dueDate: addDaysISO(today, 2),
          projectId,
          ...(t.assigneeEmployeeId ? { assigneeEmployeeId: t.assigneeEmployeeId } : {}),
        },
      },
    });
  }
  const overdue = open.filter((t) => t.dueDate && t.dueDate < today && t.status !== "BLOCKED");
  for (const t of overdue.filter((t) => !t.assigneeEmployeeId))
    steps.push({
      text: `Assign an owner to overdue #${t.number} “${t.title}” (due ${t.dueDate}).`,
      evidence: [ev(t)],
    });
  const ownedOverdue = overdue.filter((t) => t.assigneeEmployeeId);
  if (ownedOverdue.length)
    steps.push({
      text: `Agree new dates or re-prioritize ${ownedOverdue.length} overdue task${ownedOverdue.length === 1 ? "" : "s"} with their owners.`,
      evidence: ownedOverdue.slice(0, 5).map(ev),
    });
  const undated = open.filter((t) => !t.dueDate);
  if (undated.length && project.status === "ACTIVE")
    steps.push({
      text: `Set due dates for ${undated.length} open task${undated.length === 1 ? "" : "s"} without one, so progress can be tracked.`,
      evidence: undated.slice(0, 5).map(ev),
    });
  if (project.dueDate && project.dueDate < today && project.status !== "COMPLETED")
    steps.push({
      text: `The project's due date (${project.dueDate}) has passed: update it or reduce the scope.`,
      evidence: [{ kind: "project", id: project.id, label: project.name, link: `/projects/${project.id}` }],
    });
  if (!project.ownerEmployeeId)
    steps.push({
      text: "The project has no owner: assign one who is accountable for unblocking it.",
      evidence: [{ kind: "project", id: project.id, label: project.name, link: `/projects/${project.id}` }],
    });
  return {
    project: {
      id: project.id,
      name: project.name,
      status: project.status,
      dueDate: project.dueDate,
      link: `/projects/${project.id}`,
    },
    openTasks: open.length,
    steps,
    notes:
      steps.length === 0
        ? [
            "No rule matched: no blocked, overdue or undated open tasks, and the project has an owner and is on schedule.",
          ]
        : ["Suggestions follow fixed rules over this project's records; they are not predictions."],
  };
}
