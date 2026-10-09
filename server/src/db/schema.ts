import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  APPROVAL_EVENT_KINDS,
  APPROVAL_STATUSES,
  APPROVAL_TYPES,
  DOCUMENT_CATEGORIES,
  DOCUMENT_VISIBILITIES,
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  NOTIFICATION_TYPES,
  PROJECT_STATUSES,
  ROLES,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from "@shared/domain";
import type { Condition, TriggerType, WorkflowAction } from "@shared/workflows";

/*
 * Tenancy rule: every tenant-owned table carries `org_id`. Repositories must
 * always filter on it, and composite foreign keys (org_id, id) are used for
 * cross-entity references so the database itself rejects a row that points
 * at another organization's record.
 */

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const roleEnum = pgEnum("role", ROLES);
export const employeeStatusEnum = pgEnum("employee_status", EMPLOYEE_STATUSES);
export const employmentTypeEnum = pgEnum("employment_type", EMPLOYMENT_TYPES);
export const projectStatusEnum = pgEnum("project_status", PROJECT_STATUSES);
export const taskStatusEnum = pgEnum("task_status", TASK_STATUSES);
export const taskPriorityEnum = pgEnum("task_priority", TASK_PRIORITIES);
export const approvalTypeEnum = pgEnum("approval_type", APPROVAL_TYPES);
export const approvalStatusEnum = pgEnum("approval_status", APPROVAL_STATUSES);
export const approvalEventKindEnum = pgEnum("approval_event_kind", APPROVAL_EVENT_KINDS);
export const notificationTypeEnum = pgEnum("notification_type", NOTIFICATION_TYPES);

// ─── Identity ────────────────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_key").on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 of the session token. The raw token only ever lives in the cookie. */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    userAgent: text("user_agent"),
    ip: text("ip"),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

// ─── Tenancy ─────────────────────────────────────────────────────────────────

export const organizations = pgTable(
  "organizations",
  {
    id: id(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /** Monotonic counter used to give tasks human keys (e.g. FLW-12). */
    taskSeq: integer("task_seq").notNull().default(0),
    taskPrefix: text("task_prefix").notNull().default("FLW"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("organizations_slug_key").on(t.slug)],
);

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("memberships_org_user_key").on(t.orgId, t.userId),
    index("memberships_user_idx").on(t.userId),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: roleEnum("role").notNull(),
    /** SHA-256 of the invitation token. */
    tokenHash: text("token_hash").notNull(),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("invitations_token_key").on(t.tokenHash),
    index("invitations_org_idx").on(t.orgId),
    // At most one open invitation per email and organization, even under concurrent invites.
    uniqueIndex("invitations_open_email_key")
      .on(t.orgId, t.email)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
  ],
);

/**
 * Append-only. A database trigger (see migrations) rejects UPDATE and DELETE,
 * so even a buggy code path cannot rewrite history.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    summary: text("summary").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_org_created_idx").on(t.orgId, t.createdAt),
    index("audit_entity_idx").on(t.orgId, t.entityType, t.entityId),
  ],
);

// ─── People ──────────────────────────────────────────────────────────────────

export const departments = pgTable(
  "departments",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("departments_org_name_key").on(t.orgId, sql`lower(${t.name})`),
    uniqueIndex("departments_org_id_key").on(t.orgId, t.id),
  ],
);

export const employees = pgTable(
  "employees",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email").notNull(),
    jobTitle: text("job_title"),
    phone: text("phone"),
    location: text("location"),
    departmentId: uuid("department_id"),
    managerId: uuid("manager_id"),
    status: employeeStatusEnum("status").notNull().default("ACTIVE"),
    employmentType: employmentTypeEnum("employment_type").notNull().default("FULL_TIME"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("employees_org_email_key").on(t.orgId, sql`lower(${t.email})`),
    uniqueIndex("employees_org_user_key").on(t.orgId, t.userId),
    uniqueIndex("employees_org_id_key").on(t.orgId, t.id),
    index("employees_department_idx").on(t.orgId, t.departmentId),
    index("employees_manager_idx").on(t.orgId, t.managerId),
  ],
);

// ─── Execution ───────────────────────────────────────────────────────────────

export const projects = pgTable(
  "projects",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    status: projectStatusEnum("status").notNull().default("PLANNED"),
    ownerEmployeeId: uuid("owner_employee_id"),
    startDate: date("start_date"),
    dueDate: date("due_date"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("projects_org_id_key").on(t.orgId, t.id),
    index("projects_org_status_idx").on(t.orgId, t.status),
  ],
);

export const projectMembers = pgTable(
  "project_members",
  {
    orgId: uuid("org_id").notNull(),
    projectId: uuid("project_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    addedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.employeeId] })],
);

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    projectId: uuid("project_id"),
    title: text("title").notNull(),
    description: text("description"),
    status: taskStatusEnum("status").notNull().default("TODO"),
    priority: taskPriorityEnum("priority").notNull().default("MEDIUM"),
    assigneeEmployeeId: uuid("assignee_employee_id"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    dueDate: date("due_date"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tasks_org_number_key").on(t.orgId, t.number),
    uniqueIndex("tasks_org_id_key").on(t.orgId, t.id),
    index("tasks_org_status_idx").on(t.orgId, t.status),
    index("tasks_org_project_idx").on(t.orgId, t.projectId),
    index("tasks_org_assignee_idx").on(t.orgId, t.assigneeEmployeeId),
    index("tasks_org_due_idx").on(t.orgId, t.dueDate),
  ],
);

export const taskComments = pgTable(
  "task_comments",
  {
    id: id(),
    orgId: uuid("org_id").notNull(),
    taskId: uuid("task_id").notNull(),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("task_comments_task_idx").on(t.orgId, t.taskId, t.createdAt)],
);

// ─── Approvals ───────────────────────────────────────────────────────────────

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: approvalTypeEnum("type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    /** Type-specific, validated details (e.g. leave dates). */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    requesterUserId: uuid("requester_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    approverUserId: uuid("approver_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: approvalStatusEnum("status").notNull().default("PENDING"),
    decisionComment: text("decision_comment"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("approvals_org_id_key").on(t.orgId, t.id),
    index("approvals_org_approver_idx").on(t.orgId, t.approverUserId, t.status),
    index("approvals_org_requester_idx").on(t.orgId, t.requesterUserId),
    index("approvals_org_created_idx").on(t.orgId, t.createdAt),
  ],
);

export const approvalEvents = pgTable(
  "approval_events",
  {
    id: id(),
    orgId: uuid("org_id").notNull(),
    requestId: uuid("request_id").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    kind: approvalEventKindEnum("kind").notNull(),
    comment: text("comment"),
    createdAt: createdAt(),
  },
  (t) => [index("approval_events_request_idx").on(t.orgId, t.requestId, t.createdAt)],
);

// ─── Notifications ───────────────────────────────────────────────────────────

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: notificationTypeEnum("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    /** In-app path, e.g. /tasks/<id>. Never an external URL. */
    link: text("link"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_user_idx").on(t.orgId, t.userId, t.readAt, t.createdAt),
    // "All notifications, newest first" (the unread index above leads with read_at).
    index("notifications_user_created_idx").on(t.orgId, t.userId, t.createdAt),
  ],
);

// ─── Workflows ───────────────────────────────────────────────────────────────

export const WORKFLOW_RUN_STATUSES = ["PENDING", "RUNNING", "SUCCEEDED", "FAILED"] as const;
export const workflowRunStatusEnum = pgEnum("workflow_run_status", WORKFLOW_RUN_STATUSES);
export const workflowStepStatusEnum = pgEnum("workflow_step_status", ["SUCCEEDED", "FAILED"]);

/**
 * Transactional outbox. Services insert a row in the same transaction as the
 * change it describes, so an event exists if and only if the change committed.
 */
export const domainEvents = pgTable(
  "domain_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    entityId: text("entity_id"),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** How many workflow hops produced this event; deep chains are not dispatched. */
    depth: integer("depth").notNull().default(0),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("domain_events_pending_idx").on(t.dispatchedAt, t.id)],
);

export const workflows = pgTable(
  "workflows",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    enabled: boolean("enabled").notNull().default(true),
    trigger: text("trigger").$type<TriggerType>().notNull(),
    conditions: jsonb("conditions").$type<Condition[]>().notNull().default([]),
    actions: jsonb("actions").$type<WorkflowAction[]>().notNull(),
    /** Actions run with this member's current permissions. */
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("workflows_org_id_key").on(t.orgId, t.id),
    index("workflows_org_trigger_idx").on(t.orgId, t.trigger, t.enabled),
  ],
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: id(),
    orgId: uuid("org_id").notNull(),
    workflowId: uuid("workflow_id").notNull(),
    eventId: bigint("event_id", { mode: "number" })
      .notNull()
      .references(() => domainEvents.id, { onDelete: "cascade" }),
    status: workflowRunStatusEnum("status").notNull().default("PENDING"),
    /** Snapshot taken at dispatch so later edits cannot change an in-flight run. */
    actions: jsonb("actions").$type<WorkflowAction[]>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // Idempotency: an event can start a given workflow at most once.
    uniqueIndex("workflow_runs_once_key").on(t.workflowId, t.eventId),
    uniqueIndex("workflow_runs_org_id_key").on(t.orgId, t.id),
    index("workflow_runs_due_idx").on(t.status, t.nextAttemptAt),
    index("workflow_runs_workflow_idx").on(t.orgId, t.workflowId, t.createdAt),
  ],
);

export const workflowRunSteps = pgTable(
  "workflow_run_steps",
  {
    id: id(),
    orgId: uuid("org_id").notNull(),
    runId: uuid("run_id").notNull(),
    stepIndex: integer("step_index").notNull(),
    actionType: text("action_type").notNull(),
    status: workflowStepStatusEnum("status").notNull(),
    attempt: integer("attempt").notNull(),
    output: jsonb("output").$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("workflow_run_steps_run_idx").on(t.orgId, t.runId, t.stepIndex)],
);

// ─── Documents ───────────────────────────────────────────────────────────────

export const documentCategoryEnum = pgEnum("document_category", DOCUMENT_CATEGORIES);
export const documentVisibilityEnum = pgEnum("document_visibility", DOCUMENT_VISIBILITIES);

export const documents = pgTable(
  "documents",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    category: documentCategoryEnum("category").notNull().default("OTHER"),
    /** ORG: anyone with document:read. RESTRICTED: uploader, the employee it concerns, and document managers. */
    visibility: documentVisibilityEnum("visibility").notNull().default("ORG"),
    /** The employee this document concerns (contract, ID, certificate…). */
    employeeId: uuid("employee_id"),
    fileName: text("file_name").notNull(),
    /** Detected from the file's bytes, never taken from the client. */
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    /** Random storage key; never derived from user input. */
    storageKey: text("storage_key").notNull(),
    expiresOn: date("expires_on"),
    expiryNotifiedAt: timestamp("expiry_notified_at", { withTimezone: true }),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("documents_storage_key").on(t.storageKey),
    index("documents_org_idx").on(t.orgId, t.createdAt),
    index("documents_org_expiry_idx").on(t.orgId, t.expiresOn),
    // Cross-tenant expiry-reminder scan: only documents not yet reminded.
    index("documents_expiry_pending_idx")
      .on(t.expiresOn)
      .where(sql`${t.expiryNotifiedAt} is null`),
    index("documents_org_employee_idx").on(t.orgId, t.employeeId),
  ],
);

// ─── AI assistant ────────────────────────────────────────────────────────────

export const aiActionStatusEnum = pgEnum("ai_action_status", [
  "PROPOSED",
  "EXECUTED",
  "REJECTED",
  "FAILED",
  "EXPIRED",
]);

/** Private to one user within one organization. */
export const aiConversations = pgTable(
  "ai_conversations",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** Single-flight guard: one model turn at a time per conversation. */
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("ai_conversations_org_id_key").on(t.orgId, t.id),
    index("ai_conversations_user_idx").on(t.orgId, t.userId, t.updatedAt),
  ],
);

/**
 * Append-only transcript in the exact content-block form sent to and
 * returned by the model. Never edited: replaying history byte-for-byte keeps
 * thinking blocks valid and the prompt cache warm.
 */
export const aiMessages = pgTable(
  "ai_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: jsonb("content").$type<unknown[]>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("ai_messages_conversation_idx").on(t.conversationId, t.id)],
);

/** A write proposed by the model. Executes only on explicit user confirmation. */
export const aiActions = pgTable(
  "ai_actions",
  {
    id: id(),
    orgId: uuid("org_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    toolUseId: text("tool_use_id").notNull(),
    toolName: text("tool_name").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    /** SHA-256 of the canonical input; the confirmation must present the same hash. */
    inputHash: text("input_hash").notNull(),
    summary: text("summary").notNull(),
    status: aiActionStatusEnum("status").notNull().default("PROPOSED"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Set once the outcome has been reported back to the model. */
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("ai_actions_tool_use_key").on(t.conversationId, t.toolUseId),
    index("ai_actions_conversation_idx").on(t.orgId, t.conversationId),
  ],
);

/** Every tool call the model made, executed or not. */
export const aiToolCalls = pgTable(
  "ai_tool_calls",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    userId: uuid("user_id").notNull(),
    toolUseId: text("tool_use_id").notNull(),
    toolName: text("tool_name").notNull(),
    outcome: text("outcome").$type<"OK" | "ERROR" | "DENIED" | "INVALID" | "PROPOSED">().notNull(),
    error: text("error"),
    latencyMs: integer("latency_ms").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("ai_tool_calls_conversation_idx").on(t.orgId, t.conversationId)],
);

/** One row per model request: tokens, latency, outcome. */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    latencyMs: integer("latency_ms").notNull(),
    stopReason: text("stop_reason"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("ai_usage_org_idx").on(t.orgId, t.createdAt)],
);

// ─── Rate limiting ───────────────────────────────────────────────────────────

/** Fixed-window counters shared by every API instance. Keys are hashed (no raw emails/IPs). */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull(),
    resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("rate_limits_reset_idx").on(t.resetAt)],
);

/**
 * Daily operational measurements per organization, recorded by the worker
 * (hourly upsert; a day's row holds the last measurement of that UTC day).
 * Lets Insights show measured history instead of reconstructing it.
 */
export const metricSnapshots = pgTable(
  "metric_snapshots",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    openTasks: integer("open_tasks").notNull(),
    overdueTasks: integer("overdue_tasks").notNull(),
    blockedTasks: integer("blocked_tasks").notNull(),
    pendingApprovals: integer("pending_approvals").notNull(),
    measuredAt: timestamp("measured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.day] })],
);
