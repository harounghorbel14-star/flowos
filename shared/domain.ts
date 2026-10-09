/**
 * Domain vocabulary shared by server and client. Database enums are derived
 * from these lists so the two can never drift apart.
 */

export const ROLES = ["OWNER", "ADMIN", "MANAGER", "MEMBER", "VIEWER"] as const;
export type Role = (typeof ROLES)[number];

export const EMPLOYEE_STATUSES = ["ACTIVE", "ON_LEAVE", "TERMINATED"] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "CONTRACTOR", "INTERN"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const PROJECT_STATUSES = ["PLANNED", "ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const TASK_STATUSES = ["TODO", "IN_PROGRESS", "BLOCKED", "REVIEW", "DONE"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const APPROVAL_TYPES = ["LEAVE", "HR", "DOCUMENT", "PURCHASE", "GENERAL"] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export const APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_EVENT_KINDS = ["CREATED", "APPROVED", "REJECTED", "CANCELLED", "COMMENTED"] as const;
export type ApprovalEventKind = (typeof APPROVAL_EVENT_KINDS)[number];

export const LEAVE_TYPES = ["ANNUAL", "SICK", "PARENTAL", "UNPAID", "OTHER"] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];

export const DOCUMENT_CATEGORIES = [
  "CONTRACT",
  "POLICY",
  "IDENTITY",
  "CERTIFICATE",
  "INVOICE",
  "OTHER",
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export const DOCUMENT_VISIBILITIES = ["ORG", "RESTRICTED"] as const;
export type DocumentVisibility = (typeof DOCUMENT_VISIBILITIES)[number];

export const NOTIFICATION_TYPES = [
  "TASK_ASSIGNED",
  "TASK_COMMENTED",
  "APPROVAL_REQUESTED",
  "APPROVAL_DECIDED",
  "APPROVAL_CANCELLED",
  "APPROVAL_COMMENTED",
  "MEMBER_JOINED",
  "WORKFLOW_FAILED",
  "WORKFLOW_COMPLETED",
  "DOCUMENT_EXPIRING",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Human labels, used by the UI. Kept here so wording stays consistent. */
export const LABELS: Record<string, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MANAGER: "Manager",
  MEMBER: "Member",
  VIEWER: "Viewer",
  ACTIVE: "Active",
  ON_LEAVE: "On leave",
  TERMINATED: "Terminated",
  FULL_TIME: "Full-time",
  PART_TIME: "Part-time",
  CONTRACTOR: "Contractor",
  INTERN: "Intern",
  PLANNED: "Planned",
  ON_HOLD: "On hold",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  TODO: "To do",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  REVIEW: "In review",
  DONE: "Done",
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  URGENT: "Urgent",
  LEAVE: "Leave",
  HR: "HR request",
  DOCUMENT: "Document",
  PURCHASE: "Purchase",
  GENERAL: "General",
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  ANNUAL: "Annual",
  SICK: "Sick",
  PARENTAL: "Parental",
  UNPAID: "Unpaid",
  OTHER: "Other",
  CONTRACT: "Contract",
  POLICY: "Policy",
  IDENTITY: "Identity",
  CERTIFICATE: "Certificate",
  INVOICE: "Invoice",
  ORG: "Everyone in the organization",
  RESTRICTED: "Restricted",
};

export function label(value: string | null | undefined): string {
  if (!value) return "";
  return LABELS[value] ?? value;
}
