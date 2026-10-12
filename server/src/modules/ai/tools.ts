import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { TASK_PRIORITIES, TASK_STATUSES, label } from "@shared/domain";
import type { Permission } from "@shared/permissions";
import type { Database, Tx } from "../../db/client";
import { employees, projects, tasks } from "../../db/schema";
import { can, type Actor } from "../../lib/actor";
import { notFound } from "../../lib/errors";
import { isoDate } from "../../lib/validation";
import { listRequests } from "../approvals/service";
import { commandCenter } from "../dashboard/service";
import { listDocuments } from "../documents/service";
import { getEmployee, listEmployees } from "../employees/service";
import { operationalTrends } from "../insights/service";
import { markRead } from "../notifications/service";
import { listProjects } from "../projects/service";
import { createTask, getTask, listTasks, updateTask } from "../tasks/service";
import { blockedWork, overdueTasks, prioritize, resolutionSteps } from "./analysis";
import type { ModelTool } from "./runtime";

/**
 * How much a tool can change. The PolicyEngine (policy.ts) turns this into what
 * happens: reads run, low-risk own-data writes run automatically, standard
 * writes wait for the user's confirmation, high-impact operations never run.
 */
export type Risk = "read" | "low" | "standard" | "high";

export interface Verification {
  verified: boolean;
  detail: string;
}

/**
 * A tool the engine may call. Execution always goes through the regular
 * service functions with the requesting user's Actor, so tenant scoping,
 * validation and permission checks are identical to the UI.
 */
export interface ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  /** JSON Schema sent to a model; `schema` is the authority used to validate. */
  inputSchema: Record<string, unknown>;
  /** The tool is offered only if the user holds every listed permission. */
  permissions: Permission[];
  risk: Risk;
  /** Audit action recorded when a write executes. */
  auditAction?: string;
  /**
   * Exactly what a write will do, shown on the confirmation card. Resolves referenced records
   * to their names; throws NOT_FOUND for a reference outside the actor's organization.
   */
  describe?: (db: Database, actor: Actor, input: z.infer<S>) => Promise<string>;
  /**
   * The target's current state, recorded when a write is prepared and compared again at
   * confirmation: if it changed in between, the old confirmation no longer applies.
   */
  precondition?: (db: Tx, actor: Actor, input: z.infer<S>) => Promise<Record<string, unknown>>;
  execute: (db: Tx, actor: Actor, input: z.infer<S>) => Promise<unknown>;
  /** Re-read the records after a write and say whether they now match the intended change. */
  verify?: (db: Database, actor: Actor, input: z.infer<S>, result: unknown) => Promise<Verification>;
  /** One line describing a result for the step list, derived only from `output`. */
  summarize?: (output: unknown, input: z.infer<S>) => string;
}

/** Name of an employee in the actor's organization, for confirmation cards. */
async function employeeName(db: Database, actor: Actor, id: string) {
  const [e] = await db
    .select({ firstName: employees.firstName, lastName: employees.lastName })
    .from(employees)
    .where(and(eq(employees.orgId, actor.orgId), eq(employees.id, id)));
  if (!e) throw notFound("Assignee");
  return person(e.firstName, e.lastName) ?? "unnamed employee";
}

async function projectName(db: Database, actor: Actor, id: string) {
  const [p] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(and(eq(projects.orgId, actor.orgId), eq(projects.id, id)));
  if (!p) throw notFound("Project");
  return p.name;
}

const clip = (t: string, n = 80) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const uuid = z.string().uuid();
const person = (f?: string | null, l?: string | null) => [f, l].filter(Boolean).join(" ") || null;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

/** Typed at definition; erased in the registry (each input is parsed by its own schema before use). */
const def = <S extends z.ZodTypeAny>(d: ToolDef<S>): ToolDef => d as unknown as ToolDef;

type Total = { total?: number };

export const TOOLS: readonly ToolDef[] = [
  def({
    name: "get_operational_snapshot",
    description:
      "Live operational counts for the user's organization: open/overdue/blocked tasks, decisions awaiting the user, projects at risk with reasons, expiring documents, and the rule-based briefing. Use first for questions like 'what needs my attention'.",
    schema: z.object({}),
    inputSchema: obj(),
    permissions: [],
    risk: "read",
    execute: async (db, actor) => {
      const cc = await commandCenter(db as Database, actor);
      return {
        today: cc.today,
        metrics: cc.metrics,
        briefing: cc.briefing.map((b) => b.text),
        myTasks: cc.myTasks,
        approvalsAwaitingMe: cc.approvals,
        projectsAtRisk: cc.projectsAtRisk.map((p) => ({ id: p.id, name: p.name, reasons: p.reasons })),
        expiringDocuments: cc.expiringDocuments,
      };
    },
    summarize: (o) => {
      const m = (o as { metrics: Record<string, number> }).metrics;
      return `${plural(m.openTasks ?? 0, "open task")}, ${m.overdueTasks ?? 0} overdue, ${m.blockedTasks ?? 0} blocked, ${plural(m.approvalsAwaitingMe ?? 0, "approval")} waiting for you`;
    },
  }),
  def({
    name: "analyze_priorities",
    description:
      "FLOWOS prioritization for the user: their open tasks, approvals waiting for their decision and projects they own at risk, ranked by documented rules (priority, lateness, deadlines, blocked state, waiting time). Each item has its reasons. Use for 'what should I focus on today'.",
    schema: z.object({ limit: z.number().int().min(1).max(20).default(10) }),
    inputSchema: obj({ limit: { type: "integer", minimum: 1, maximum: 20 } }),
    permissions: [],
    risk: "read",
    execute: (db, actor, input) => prioritize(db as Database, actor, input.limit),
    summarize: (o) => {
      const r = o as Awaited<ReturnType<typeof prioritize>>;
      return `Ranked ${plural(r.considered, "item")}; top: ${r.items[0]?.title ?? "nothing pending"}`;
    },
  }),
  def({
    name: "analyze_overdue_tasks",
    description:
      "Open tasks past their due date, ranked by urgency (priority × lateness, unassigned first among equals), each with reasons. `mine` limits to the user's tasks.",
    schema: z.object({
      mine: z.boolean().default(false),
      limit: z.number().int().min(1).max(25).default(10),
    }),
    inputSchema: obj({ mine: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 25 } }),
    permissions: ["task:read"],
    risk: "read",
    execute: (db, actor, input) => overdueTasks(db as Database, actor, input),
    summarize: (o) => {
      const r = o as Awaited<ReturnType<typeof overdueTasks>>;
      return r.total === 0
        ? "No overdue tasks"
        : `${plural(r.total, "overdue task")}; most urgent: ${r.items[0]!.title}`;
    },
  }),
  def({
    name: "analyze_blocked_work",
    description:
      "Projects that appear blocked, with the evidence: tasks marked Blocked, projects On hold, overdue work, past due dates. FLOWOS has no task dependencies, so say so when relevant.",
    schema: z.object({}),
    inputSchema: obj(),
    permissions: ["project:read", "task:read"],
    risk: "read",
    execute: (db, actor) => blockedWork(db as Database, actor),
    summarize: (o) => {
      const r = o as Awaited<ReturnType<typeof blockedWork>>;
      const blocked = r.projects.filter((p) => p.appearsBlocked).length;
      return `${plural(blocked, "project")} ${blocked === 1 ? "appears" : "appear"} blocked; ${plural(r.blockedTaskCount, "task")} marked Blocked`;
    },
  }),
  def({
    name: "suggest_next_steps",
    description:
      "Rule-based next steps to resolve problems in one project (blocked, overdue, unassigned or undated tasks, missed due date, missing owner), each tied to the records that triggered it.",
    schema: z.object({ projectId: uuid }),
    inputSchema: obj({ projectId: { type: "string" } }, ["projectId"]),
    permissions: ["project:read", "task:read"],
    risk: "read",
    execute: (db, actor, input) => resolutionSteps(db as Database, actor, input.projectId),
    summarize: (o) => {
      const r = o as Awaited<ReturnType<typeof resolutionSteps>>;
      return `${plural(r.steps.length, "suggested step")} for ${r.project.name}`;
    },
  }),
  def({
    name: "get_weekly_trends",
    description:
      "Measured week-over-week trends: tasks created/completed per week for 8 weeks, open overdue tasks at each week end, last-7-days vs previous-7-days counts, and (if permitted) approval turnaround and workflow failures. Each figure comes with its definition; report them as facts, not causes.",
    schema: z.object({}),
    inputSchema: obj(),
    permissions: ["task:read"],
    risk: "read",
    execute: async (db, actor) => {
      const t = await operationalTrends(db as Database, actor);
      return {
        definitions: t.definitions,
        weeks: t.weeks,
        rolling: t.rolling,
        approvals: t.approvals,
        workflowFailures: t.workflows?.failing ?? null,
        notable: t.notable.map((n) => n.summary),
      };
    },
    summarize: (o) => {
      const n = (o as { notable: string[] }).notable;
      return n.length ? n[0]! : "Trends loaded; nothing notable";
    },
  }),
  def({
    name: "search_people",
    description:
      "Search the employee directory by name, email or job title. Returns up to `limit` people with their department and manager.",
    schema: z.object({
      query: z.string().max(100).default(""),
      limit: z.number().int().min(1).max(25).default(10),
    }),
    inputSchema: obj({
      query: { type: "string", description: "Text to match; empty lists everyone" },
      limit: { type: "integer", minimum: 1, maximum: 25 },
    }),
    permissions: ["employee:read"],
    risk: "read",
    execute: async (db, actor, input) => {
      const page = await listEmployees(db as Database, actor, {
        page: 1,
        pageSize: input.limit,
        search: input.query || undefined,
        sort: "name",
      });
      return {
        total: page.total,
        people: page.items.map((e) => ({
          employeeId: e.id,
          name: person(e.firstName, e.lastName),
          jobTitle: e.jobTitle,
          status: e.status,
          department: e.departmentName,
          manager: person(e.managerFirstName, e.managerLastName),
        })),
      };
    },
    summarize: (o) => plural((o as Total).total ?? 0, "person") + " found",
  }),
  def({
    name: "get_person",
    description: "Full profile of one employee: role, department, manager, direct reports and task counts.",
    schema: z.object({ employeeId: uuid }),
    inputSchema: obj({ employeeId: { type: "string" } }, ["employeeId"]),
    permissions: ["employee:read"],
    risk: "read",
    execute: async (db, actor, input) => {
      const e = await getEmployee(db as Database, actor, input.employeeId);
      return {
        employeeId: e.id,
        name: person(e.firstName, e.lastName),
        email: e.email,
        jobTitle: e.jobTitle,
        status: e.status,
        employmentType: e.employmentType,
        department: e.departmentName,
        manager: person(e.managerFirstName, e.managerLastName),
        startDate: e.startDate,
        directReports: e.directReports.map((r) => person(r.firstName, r.lastName)),
        tasks: e.taskStats,
      };
    },
    summarize: (o) => `Opened ${(o as { name: string }).name}`,
  }),
  def({
    name: "list_tasks",
    description:
      "List tasks with filters. `mine` limits to tasks assigned to the user; `overdue` to open tasks past their due date. Sorted by due date.",
    schema: z.object({
      mine: z.boolean().optional(),
      overdue: z.boolean().optional(),
      statuses: z.array(z.enum(TASK_STATUSES)).max(5).optional(),
      search: z.string().max(100).optional(),
      projectId: uuid.optional(),
      assigneeEmployeeId: uuid.optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    inputSchema: obj({
      mine: { type: "boolean" },
      overdue: { type: "boolean" },
      statuses: { type: "array", items: { type: "string", enum: [...TASK_STATUSES] } },
      search: { type: "string" },
      projectId: { type: "string" },
      assigneeEmployeeId: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    }),
    permissions: ["task:read"],
    risk: "read",
    execute: async (db, actor, input) => {
      const page = await listTasks(db as Database, actor, {
        page: 1,
        pageSize: input.limit,
        sort: "due",
        ...input,
      });
      return {
        total: page.total,
        tasks: page.items.map((t) => ({
          taskId: t.id,
          number: t.number,
          title: t.title,
          status: t.status,
          priority: t.priority,
          dueDate: t.dueDate,
          project: t.projectName,
          projectId: t.projectId,
          assignee: person(t.assigneeFirstName, t.assigneeLastName),
          assigneeEmployeeId: t.assigneeEmployeeId,
        })),
      };
    },
    summarize: (o) => plural((o as Total).total ?? 0, "task") + " found",
  }),
  def({
    name: "get_task",
    description: "Details of one task including description, comments and recent activity.",
    schema: z.object({ taskId: uuid }),
    inputSchema: obj({ taskId: { type: "string" } }, ["taskId"]),
    permissions: ["task:read"],
    risk: "read",
    execute: async (db, actor, input) => {
      const t = await getTask(db as Database, actor, input.taskId);
      return {
        taskId: t.id,
        key: t.key,
        title: t.title,
        description: t.description,
        status: t.status,
        priority: t.priority,
        dueDate: t.dueDate,
        project: t.projectName,
        assignee: person(t.assigneeFirstName, t.assigneeLastName),
        canEdit: t.canEdit,
        comments: t.comments
          .slice(-10)
          .map((c) => ({ author: c.authorName, body: c.body.slice(0, 500), at: c.createdAt })),
        activity: t.history.slice(0, 10).map((h) => h.summary),
      };
    },
    summarize: (o) => `Opened ${(o as { key: string }).key}`,
  }),
  def({
    name: "list_projects",
    description: "List projects with progress (share of tasks done) and explicit risk reasons.",
    schema: z.object({
      search: z.string().max(100).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    inputSchema: obj({ search: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } }),
    permissions: ["project:read"],
    risk: "read",
    execute: async (db, actor, input) => {
      const page = await listProjects(db as Database, actor, {
        page: 1,
        pageSize: input.limit,
        search: input.search,
        sort: "due",
      });
      return {
        total: page.total,
        projects: page.items.map((p) => ({
          projectId: p.id,
          name: p.name,
          status: p.status,
          dueDate: p.dueDate,
          owner: person(p.ownerFirstName, p.ownerLastName),
          tasks: {
            total: p.stats.total,
            done: p.stats.done,
            overdue: p.stats.overdue,
            blocked: p.stats.blocked,
          },
          riskReasons: p.risk,
        })),
      };
    },
    summarize: (o) => plural((o as Total).total ?? 0, "project") + " found",
  }),
  def({
    name: "list_my_approvals",
    description:
      "Approval requests waiting for the user's decision (inbox) or that the user submitted (outbox).",
    schema: z.object({
      box: z.enum(["inbox", "outbox"]).default("inbox"),
      pendingOnly: z.boolean().default(true),
    }),
    inputSchema: obj({
      box: { type: "string", enum: ["inbox", "outbox"] },
      pendingOnly: { type: "boolean" },
    }),
    permissions: [],
    risk: "read",
    execute: async (db, actor, input) => {
      const page = await listRequests(db as Database, actor, {
        page: 1,
        pageSize: 25,
        box: input.box,
        status: input.pendingOnly ? "PENDING" : undefined,
      });
      return {
        total: page.total,
        requests: page.items.map((r) => ({
          approvalId: r.id,
          type: r.type,
          title: r.title,
          status: r.status,
          requester: r.requesterName,
          approver: r.approverName,
          submittedAt: r.createdAt,
        })),
      };
    },
    summarize: (o, i) => `${plural((o as Total).total ?? 0, "request")} in your ${i.box}`,
  }),
  def({
    name: "search_documents",
    description:
      "Search document metadata (title, category, expiry) the user is allowed to see. File contents are not available.",
    schema: z.object({ query: z.string().max(100).default(""), expiringOnly: z.boolean().default(false) }),
    inputSchema: obj({
      query: { type: "string" },
      expiringOnly: { type: "boolean", description: "Only documents expired or expiring within 30 days" },
    }),
    permissions: ["document:read"],
    risk: "read",
    execute: async (db, actor, input) => {
      const page = await listDocuments(db as Database, actor, {
        page: 1,
        pageSize: 20,
        search: input.query || undefined,
        expiring: input.expiringOnly || undefined,
      });
      return {
        total: page.total,
        documents: page.items.map((d) => ({
          title: d.title,
          category: d.category,
          expiresOn: d.expiresOn,
          concerns: person(d.employeeFirstName, d.employeeLastName),
          fileName: d.fileName,
        })),
      };
    },
    summarize: (o) => plural((o as Total).total ?? 0, "document") + " found",
  }),
  def({
    name: "mark_notifications_read",
    description:
      "Mark the user's own unread notifications as read (all of them, or the given ids). Low-risk: affects only the user's own inbox.",
    schema: z.object({ notificationIds: z.array(uuid).max(50).optional() }),
    inputSchema: obj({ notificationIds: { type: "array", items: { type: "string" } } }),
    permissions: [],
    risk: "low",
    auditAction: "ai.notifications_read",
    execute: (db, actor, input) => markRead(db as Database, actor, input.notificationIds),
    verify: async (_db, _actor, _input, result) => ({
      verified: typeof (result as { updated?: unknown }).updated === "number",
      detail: `${plural((result as { updated: number }).updated, "notification")} marked read`,
    }),
    summarize: (o) => `${plural((o as { updated: number }).updated, "notification")} marked read`,
  }),
  def({
    name: "create_task",
    description:
      "Prepare a new task. This does NOT create it: the user must confirm the prepared action. Resolve assignees and projects to IDs with search_people / list_projects first.",
    schema: z.object({
      title: z.string().trim().min(1).max(200),
      description: z.string().max(5000).optional(),
      priority: z.enum(TASK_PRIORITIES).default("MEDIUM"),
      dueDate: isoDate.optional(),
      assigneeEmployeeId: uuid.optional(),
      projectId: uuid.optional(),
    }),
    inputSchema: obj(
      {
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string", enum: [...TASK_PRIORITIES] },
        dueDate: { type: "string", description: "YYYY-MM-DD" },
        assigneeEmployeeId: { type: "string" },
        projectId: { type: "string" },
      },
      ["title"],
    ),
    permissions: ["task:create"],
    risk: "standard",
    auditAction: "ai.task_created",
    describe: async (db, actor, i) =>
      [
        `Create task “${clip(i.title)}”`,
        `${label(i.priority)} priority`,
        i.dueDate ? `due ${i.dueDate}` : "no due date",
        i.assigneeEmployeeId
          ? `assigned to ${await employeeName(db, actor, i.assigneeEmployeeId)}`
          : "unassigned",
        i.projectId ? `in project ${await projectName(db, actor, i.projectId)}` : null,
        i.description ? `description: “${clip(i.description)}”` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    // A new record has no prior state; references are re-checked by the service at execution.
    execute: async (db, actor, input) => {
      const t = await createTask(db, actor, {
        title: input.title,
        description: input.description ?? null,
        priority: input.priority,
        dueDate: input.dueDate ?? null,
        assigneeEmployeeId: input.assigneeEmployeeId ?? null,
        projectId: input.projectId ?? null,
      });
      return { taskId: t.id, number: t.number, title: t.title };
    },
    verify: async (db, actor, input, result) => {
      const r = result as { taskId: string };
      const t = await getTask(db, actor, r.taskId);
      const ok =
        t.title === input.title &&
        t.priority === input.priority &&
        (t.dueDate ?? undefined) === input.dueDate &&
        (t.assigneeEmployeeId ?? undefined) === input.assigneeEmployeeId &&
        (t.projectId ?? undefined) === input.projectId;
      return {
        verified: ok,
        detail: ok
          ? `Task ${t.key} exists with the confirmed details`
          : `Task ${t.key} differs from what was confirmed`,
      };
    },
    summarize: (o) => `Created task #${(o as { number: number }).number}`,
  }),
  def({
    name: "update_task_status",
    description: "Prepare a status change for one task. The user must confirm it before it happens.",
    schema: z.object({ taskId: uuid, status: z.enum(TASK_STATUSES) }),
    inputSchema: obj({ taskId: { type: "string" }, status: { type: "string", enum: [...TASK_STATUSES] } }, [
      "taskId",
      "status",
    ]),
    // Every role that can edit any task holds write_own; the service still checks the specific task.
    permissions: ["task:read", "task:write_own"],
    risk: "standard",
    auditAction: "ai.task_status_changed",
    describe: async (db, actor, i) => {
      const [t] = await db
        .select({ number: tasks.number, title: tasks.title, status: tasks.status })
        .from(tasks)
        .where(and(eq(tasks.orgId, actor.orgId), eq(tasks.id, i.taskId)));
      if (!t) throw notFound("Task");
      return `Move task #${t.number} “${clip(t.title)}” from “${label(t.status)}” to “${label(i.status)}”`;
    },
    precondition: async (db, actor, i) => {
      const [t] = await db
        .select({ status: tasks.status })
        .from(tasks)
        .where(and(eq(tasks.orgId, actor.orgId), eq(tasks.id, i.taskId)));
      if (!t) throw notFound("Task");
      return { status: t.status };
    },
    execute: async (db, actor, input) => {
      const t = await updateTask(db, actor, input.taskId, { status: input.status });
      return { taskId: t.id, title: t.title, status: t.status };
    },
    verify: async (db, actor, input) => {
      const t = await getTask(db, actor, input.taskId);
      return {
        verified: t.status === input.status,
        detail:
          t.status === input.status
            ? `${t.key} is now “${label(t.status)}”`
            : `${t.key} is “${label(t.status)}”, not “${label(input.status)}”`,
      };
    },
    summarize: (o) => `Status is now ${label((o as { status: (typeof TASK_STATUSES)[number] }).status)}`,
  }),
];

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** Tools this actor may use; nothing else is offered or run. */
export function toolsFor(actor: Actor): ToolDef[] {
  return TOOLS.filter((t) => t.risk !== "high" && t.permissions.every((p) => can(actor, p)));
}

export function toModelTools(tools: ToolDef[]): ModelTool[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}
