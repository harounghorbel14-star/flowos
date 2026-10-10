import { z } from "zod";
import { EMPLOYEE_STATUSES, EMPLOYMENT_TYPES, TASK_PRIORITIES, TASK_STATUSES } from "./domain";
import { MESSAGING_INTEGRATIONS } from "./integrations";

/**
 * Workflow model: WHEN <trigger> IF <conditions> THEN <actions>.
 * Everything here is declarative data — workflows never execute user code.
 */

export interface TriggerField {
  key: string;
  label: string;
  /** Enumerated values, when the field is an enum. */
  values?: readonly string[];
}

export const TRIGGERS = {
  "employee.created": {
    label: "Employee added to the directory",
    fields: [
      { key: "firstName", label: "First name" },
      { key: "lastName", label: "Last name" },
      { key: "email", label: "Email" },
      { key: "jobTitle", label: "Job title" },
      { key: "status", label: "Status", values: EMPLOYEE_STATUSES },
      { key: "employmentType", label: "Employment type", values: EMPLOYMENT_TYPES },
      { key: "departmentName", label: "Department" },
      { key: "startDate", label: "Start date" },
    ],
  },
  "task.status_changed": {
    label: "Task status changes",
    fields: [
      { key: "title", label: "Task title" },
      { key: "from", label: "Previous status", values: TASK_STATUSES },
      { key: "to", label: "New status", values: TASK_STATUSES },
      { key: "priority", label: "Priority", values: TASK_PRIORITIES },
      { key: "projectName", label: "Project" },
    ],
  },
  "approval.decided": {
    label: "Approval request decided",
    fields: [
      { key: "title", label: "Request title" },
      { key: "type", label: "Request type", values: ["LEAVE", "HR", "DOCUMENT", "PURCHASE", "GENERAL"] },
      { key: "decision", label: "Decision", values: ["APPROVED", "REJECTED"] },
      { key: "requesterName", label: "Requester" },
    ],
  },
} as const satisfies Record<string, { label: string; fields: readonly TriggerField[] }>;

export type TriggerType = keyof typeof TRIGGERS;
export const TRIGGER_TYPES = Object.keys(TRIGGERS) as TriggerType[];

export const CONDITION_OPS = ["eq", "neq", "contains", "is_set", "is_empty"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];
export const OP_LABELS: Record<ConditionOp, string> = {
  eq: "is",
  neq: "is not",
  contains: "contains",
  is_set: "is set",
  is_empty: "is empty",
};

export const conditionSchema = z.object({
  field: z.string().min(1).max(40),
  op: z.enum(CONDITION_OPS),
  value: z.string().max(200).default(""),
});
export type Condition = z.infer<typeof conditionSchema>;

/** Who a created task is assigned to, resolved from the triggering event. */
export const ASSIGNEE_RULES = ["none", "subject_employee", "subject_manager", "fixed_employee"] as const;
export const RECIPIENT_RULES = ["workflow_owner", "subject_user", "subject_manager", "fixed_user"] as const;

const template = z.string().trim().min(1).max(200);

export const actionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_task"),
    title: template,
    description: z.string().max(2000).default(""),
    priority: z.enum(TASK_PRIORITIES).default("MEDIUM"),
    dueInDays: z.number().int().min(0).max(365).nullable().default(null),
    assignee: z.enum(ASSIGNEE_RULES).default("none"),
    employeeId: z.string().uuid().nullable().default(null),
  }),
  z.object({
    type: z.literal("notify"),
    title: template,
    body: z.string().max(500).default(""),
    recipient: z.enum(RECIPIENT_RULES).default("workflow_owner"),
    userId: z.string().uuid().nullable().default(null),
  }),
  z.object({
    type: z.literal("send_message"),
    /** A connected messaging integration (Settings → Integrations). */
    provider: z.enum(MESSAGING_INTEGRATIONS),
    text: z.string().trim().min(1).max(1000),
  }),
]);
export type WorkflowAction = z.infer<typeof actionSchema>;
export type ActionType = WorkflowAction["type"];

export const ACTION_LABELS: Record<ActionType, string> = {
  create_task: "Create a task",
  notify: "Send an in-app notification",
  send_message: "Post a message to Slack or Teams",
};

export const ASSIGNEE_LABELS: Record<(typeof ASSIGNEE_RULES)[number], string> = {
  none: "Leave unassigned",
  subject_employee: "The employee who triggered it",
  subject_manager: "That employee's manager",
  fixed_employee: "A specific employee",
};

export const RECIPIENT_LABELS: Record<(typeof RECIPIENT_RULES)[number], string> = {
  workflow_owner: "Workflow owner",
  subject_user: "The person involved (employee / requester / assignee)",
  subject_manager: "Their manager",
  fixed_user: "A specific member",
};

export const WORKFLOW_LIMITS = { conditions: 10, actions: 10 } as const;

/** Replace {{field}} with values from the event. Output is plain text, never HTML. */
export function renderTemplate(tpl: string, data: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g, (_m, key: string) => {
    const v = data[key];
    return v === null || v === undefined ? "" : String(v);
  });
}

export function evaluateCondition(c: Condition, data: Record<string, unknown>): boolean {
  const raw = data[c.field];
  const value = raw === null || raw === undefined ? "" : String(raw);
  switch (c.op) {
    case "eq":
      return value === c.value;
    case "neq":
      return value !== c.value;
    case "contains":
      return value.toLowerCase().includes(c.value.toLowerCase());
    case "is_set":
      return value !== "";
    case "is_empty":
      return value === "";
  }
}

/** A ready-made onboarding workflow, offered as a one-click template. */
export const ONBOARDING_TEMPLATE = {
  name: "Employee onboarding",
  description:
    "When an active employee is added: prepare their equipment, schedule a welcome, and tell the owner.",
  trigger: "employee.created" as TriggerType,
  conditions: [{ field: "status", op: "eq", value: "ACTIVE" }] as Condition[],
  actions: [
    {
      type: "create_task",
      title: "Prepare equipment and accounts for {{firstName}} {{lastName}}",
      description: "Laptop, email, and access to the tools {{firstName}} needs on day one.",
      priority: "HIGH",
      dueInDays: 3,
      assignee: "subject_manager",
      employeeId: null,
    },
    {
      type: "create_task",
      title: "Welcome meeting with {{firstName}}",
      description: "Introduce the team, the first-week plan and who to ask for help.",
      priority: "MEDIUM",
      dueInDays: 5,
      assignee: "subject_employee",
      employeeId: null,
    },
    {
      type: "notify",
      title: "Onboarding started for {{firstName}} {{lastName}}",
      body: "Onboarding tasks were created automatically.",
      recipient: "workflow_owner",
      userId: null,
    },
  ] as WorkflowAction[],
};
