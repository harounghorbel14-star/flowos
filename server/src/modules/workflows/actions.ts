import { and, eq } from "drizzle-orm";
import { renderTemplate, type WorkflowAction } from "@shared/workflows";
import type { Tx } from "../../db/client";
import { employees } from "../../db/schema";
import type { Actor } from "../../lib/actor";
import { addDaysISO, todayISO } from "../../lib/dates";
import { AppError } from "../../lib/errors";
import { requireEmployee, requireMember } from "../../lib/refs";
import { notify } from "../notifications/service";
import { createTask } from "../tasks/service";

/** An error that retrying cannot fix (e.g. a referenced record no longer exists). */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

export interface ActionContext {
  /** The workflow owner's identity and *current* role — never elevated. */
  actor: Actor;
  payload: Record<string, unknown>;
  ownerUserId: string;
}

async function managerOf(tx: Tx, orgId: string, employeeId: string | null) {
  if (!employeeId) return null;
  const [row] = await tx
    .select({ managerId: employees.managerId })
    .from(employees)
    .where(and(eq(employees.orgId, orgId), eq(employees.id, employeeId)));
  if (!row?.managerId) return null;
  const [manager] = await tx
    .select({ id: employees.id, userId: employees.userId })
    .from(employees)
    .where(and(eq(employees.orgId, orgId), eq(employees.id, row.managerId)));
  return manager ?? null;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/**
 * Execute one action inside the caller's transaction. Side effects go through
 * the same service functions the API uses, so tenant scoping, validation,
 * permission checks, audit and notifications all apply unchanged.
 */
export async function executeAction(
  tx: Tx,
  ctx: ActionContext,
  action: WorkflowAction,
): Promise<Record<string, unknown>> {
  const { actor, payload } = ctx;
  const subjectEmployeeId = str(payload.subjectEmployeeId);
  const subjectUserId = str(payload.subjectUserId);

  switch (action.type) {
    case "create_task": {
      let assigneeEmployeeId: string | null = null;
      if (action.assignee === "subject_employee") assigneeEmployeeId = subjectEmployeeId;
      else if (action.assignee === "subject_manager")
        assigneeEmployeeId = (await managerOf(tx, actor.orgId, subjectEmployeeId))?.id ?? null;
      else if (action.assignee === "fixed_employee") {
        if (!action.employeeId) throw new PermanentError("No employee chosen for the task assignee.");
        try {
          await requireEmployee(tx, actor.orgId, action.employeeId, "Assignee");
        } catch {
          throw new PermanentError("The configured assignee no longer exists.");
        }
        assigneeEmployeeId = action.employeeId;
      }
      const task = await createTask(tx, actor, {
        title: renderTemplate(action.title, payload).slice(0, 200) || "Untitled task",
        description: renderTemplate(action.description, payload) || null,
        priority: action.priority,
        assigneeEmployeeId,
        dueDate: action.dueInDays === null ? null : addDaysISO(todayISO(), action.dueInDays),
      });
      return { taskId: task.id, number: task.number, assigneeEmployeeId };
    }
    case "notify": {
      let userId: string | null = null;
      if (action.recipient === "workflow_owner") userId = ctx.ownerUserId;
      else if (action.recipient === "subject_user") userId = subjectUserId;
      else if (action.recipient === "subject_manager")
        userId = (await managerOf(tx, actor.orgId, subjectEmployeeId))?.userId ?? null;
      else if (action.recipient === "fixed_user") {
        if (!action.userId) throw new PermanentError("No member chosen as recipient.");
        try {
          await requireMember(tx, actor.orgId, action.userId);
        } catch {
          throw new PermanentError("The configured recipient is no longer a member.");
        }
        userId = action.userId;
      }
      // A rule resolving to nobody (e.g. no manager on file) is a no-op, recorded as such.
      if (!userId) return { delivered: false, reason: "No recipient resolved for this event." };
      await notify(tx, {
        orgId: actor.orgId,
        userId,
        actorUserId: null,
        type: "WORKFLOW_COMPLETED",
        title: renderTemplate(action.title, payload).slice(0, 300),
        body: renderTemplate(action.body, payload) || null,
        link: "/workflows",
      });
      return { delivered: true, userId };
    }
    default:
      throw new PermanentError(`Unknown action type “${(action as { type: string }).type}”.`);
  }
}

/** Errors whose message is safe to store and show; everything else is masked. */
export function describeError(err: unknown): string {
  if (err instanceof PermanentError || err instanceof AppError) return err.message;
  return "Unexpected error while running this step. See server logs.";
}
