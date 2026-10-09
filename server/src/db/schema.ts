import { sql } from "drizzle-orm";
import {
  bigserial,
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
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  NOTIFICATION_TYPES,
  PROJECT_STATUSES,
  ROLES,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from "@shared/domain";

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
  (t) => [index("sessions_user_idx").on(t.userId)],
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
  (t) => [uniqueIndex("invitations_token_key").on(t.tokenHash), index("invitations_org_idx").on(t.orgId)],
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
  (t) => [index("notifications_user_idx").on(t.orgId, t.userId, t.readAt, t.createdAt)],
);
