import { z } from "zod";
import { TASK_PRIORITIES, TASK_STATUSES, label } from "@shared/domain";
import type { Permission } from "@shared/permissions";
import type { Database, Tx } from "../../db/client";
import { can, type Actor } from "../../lib/actor";
import { listRequests } from "../approvals/service";
import { commandCenter } from "../dashboard/service";
import { listDocuments } from "../documents/service";
import { operationalTrends } from "../insights/service";
import { getEmployee, listEmployees } from "../employees/service";
import { listProjects } from "../projects/service";
import { createTask, getTask, listTasks, updateTask } from "../tasks/service";
import type { AiTool } from "./provider";
import { isoDate } from "../../lib/validation";
import { and, eq } from "drizzle-orm";
import { employees, projects, tasks } from "../../db/schema";
import { notFound } from "../../lib/errors";

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

/**
 * A tool the assistant may call. Execution always goes through the regular
 * service functions with the requesting user's Actor, so tenant scoping,
 * validation and permission checks are identical to the UI.
 */
export interface ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  /** JSON Schema sent to the model; `schema` is the authority used to validate. */
  inputSchema: AiTool["input_schema"];
  /** The model only sees a tool if the user holds every listed permission. */
  permissions: Permission[];
  risk: "read" | "write";
  /** Writes are prepared and need explicit user confirmation before they run. */
  confirmation: "never" | "always";
  /** Audit action recorded when a confirmed write executes. */
  auditAction?: string;
  /**
   * Human-readable description of exactly what a write will do, shown on the
   * confirmation card. Resolves referenced records to their names so the user
   * sees which task, person and project are affected; throws NOT_FOUND for a
   * reference outside the actor's organization.
   */
  describe?: (db: Database, actor: Actor, input: z.infer<S>) => Promise<string>;
  execute: (db: Tx, actor: Actor, input: z.infer<S>) => Promise<unknown>;
}

/** Typed at definition; erased in the registry (each input is parsed by its own schema before use). */
const def = <S extends z.ZodTypeAny>(d: ToolDef<S>): ToolDef => d as unknown as ToolDef;
const person = (f?: string | null, l?: string | null) => [f, l].filter(Boolean).join(" ") || null;

export const TOOLS: readonly ToolDef[] = [
  def({
    name: "get_operational_snapshot",
    description:
      "Live operational counts for the user's organization: open/overdue/blocked tasks, decisions awaiting the user, projects at risk with reasons, expiring documents, and the rule-based briefing. Use first for questions like 'what needs my attention'.",
    schema: z.object({}),
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    permissions: [],
    risk: "read",
    confirmation: "never",
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
  }),
  def({
    name: "get_weekly_trends",
    description:
      "Measured week-over-week trends: tasks created/completed per week for 8 weeks, open overdue tasks at each week end, last-7-days vs previous-7-days counts, and (if permitted) approval turnaround and workflow failures. Each figure comes with its definition; report them as facts, not causes.",
    schema: z.object({}),
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    permissions: ["task:read"],
    risk: "read",
    confirmation: "never",
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
  }),
  def({
    name: "search_people",
    description:
      "Search the employee directory by name, email or job title. Returns up to `limit` people with their department and manager.",
    schema: z.object({
      query: z.string().max(100).default(""),
      limit: z.number().int().min(1).max(25).default(10),
    }),
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to match; empty lists everyone" },
        limit: { type: "integer", minimum: 1, maximum: 25 },
      },
      additionalProperties: false,
    },
    permissions: ["employee:read"],
    risk: "read",
    confirmation: "never",
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
  }),
  def({
    name: "get_person",
    description: "Full profile of one employee: role, department, manager, direct reports and task counts.",
    schema: z.object({ employeeId: uuid }),
    inputSchema: {
      type: "object",
      properties: { employeeId: { type: "string" } },
      required: ["employeeId"],
      additionalProperties: false,
    },
    permissions: ["employee:read"],
    risk: "read",
    confirmation: "never",
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
    inputSchema: {
      type: "object",
      properties: {
        mine: { type: "boolean" },
        overdue: { type: "boolean" },
        statuses: { type: "array", items: { type: "string", enum: [...TASK_STATUSES] } },
        search: { type: "string" },
        projectId: { type: "string" },
        assigneeEmployeeId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    permissions: ["task:read"],
    risk: "read",
    confirmation: "never",
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
          assignee: person(t.assigneeFirstName, t.assigneeLastName),
        })),
      };
    },
  }),
  def({
    name: "get_task",
    description: "Details of one task including description, comments and recent activity.",
    schema: z.object({ taskId: uuid }),
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    },
    permissions: ["task:read"],
    risk: "read",
    confirmation: "never",
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
  }),
  def({
    name: "list_projects",
    description: "List projects with progress (share of tasks done) and explicit risk reasons.",
    schema: z.object({
      search: z.string().max(100).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    inputSchema: {
      type: "object",
      properties: { search: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
    permissions: ["project:read"],
    risk: "read",
    confirmation: "never",
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
  }),
  def({
    name: "list_my_approvals",
    description:
      "Approval requests waiting for the user's decision (inbox) or that the user submitted (outbox).",
    schema: z.object({
      box: z.enum(["inbox", "outbox"]).default("inbox"),
      pendingOnly: z.boolean().default(true),
    }),
    inputSchema: {
      type: "object",
      properties: { box: { type: "string", enum: ["inbox", "outbox"] }, pendingOnly: { type: "boolean" } },
      additionalProperties: false,
    },
    permissions: [],
    risk: "read",
    confirmation: "never",
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
  }),
  def({
    name: "search_documents",
    description:
      "Search document metadata (title, category, expiry) the user is allowed to see. File contents are not available.",
    schema: z.object({ query: z.string().max(100).default(""), expiringOnly: z.boolean().default(false) }),
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        expiringOnly: { type: "boolean", description: "Only documents expired or expiring within 30 days" },
      },
      additionalProperties: false,
    },
    permissions: ["document:read"],
    risk: "read",
    confirmation: "never",
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
  }),
  def({
    name: "create_task",
    description:
      "Prepare a new task. This does NOT create it: the user must confirm the prepared action in the interface. Resolve assignees and projects to IDs with search_people / list_projects first.",
    schema: z.object({
      title: z.string().trim().min(1).max(200),
      description: z.string().max(5000).optional(),
      priority: z.enum(TASK_PRIORITIES).default("MEDIUM"),
      dueDate: isoDate.optional(),
      assigneeEmployeeId: uuid.optional(),
      projectId: uuid.optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string", enum: [...TASK_PRIORITIES] },
        dueDate: { type: "string", description: "YYYY-MM-DD" },
        assigneeEmployeeId: { type: "string" },
        projectId: { type: "string" },
      },
      required: ["title"],
      additionalProperties: false,
    },
    permissions: ["task:create"],
    risk: "write",
    confirmation: "always",
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
  }),
  def({
    name: "update_task_status",
    description:
      "Prepare a status change for one task. The user must confirm it in the interface before it happens.",
    schema: z.object({ taskId: uuid, status: z.enum(TASK_STATUSES) }),
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" }, status: { type: "string", enum: [...TASK_STATUSES] } },
      required: ["taskId", "status"],
      additionalProperties: false,
    },
    // Every role that can edit any task holds write_own; the service still checks the specific task.
    permissions: ["task:read", "task:write_own"],
    risk: "write",
    confirmation: "always",
    auditAction: "ai.task_status_changed",
    describe: async (db, actor, i) => {
      const [t] = await db
        .select({ number: tasks.number, title: tasks.title, status: tasks.status })
        .from(tasks)
        .where(and(eq(tasks.orgId, actor.orgId), eq(tasks.id, i.taskId)));
      if (!t) throw notFound("Task");
      return `Move task #${t.number} “${clip(t.title)}” from “${label(t.status)}” to “${label(i.status)}”`;
    },
    execute: async (db, actor, input) => {
      const t = await updateTask(db, actor, input.taskId, { status: input.status });
      return { taskId: t.id, title: t.title, status: t.status };
    },
  }),
];

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** Tools this actor may use; the model never sees the others. */
export function toolsFor(actor: Actor): ToolDef[] {
  return TOOLS.filter((t) => t.permissions.every((p) => can(actor, p)));
}

export function toApiTools(tools: ToolDef[]): AiTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
    // Stream large inputs as generated; inputs are validated with Zod before use.
    eager_input_streaming: true,
  }));
}
