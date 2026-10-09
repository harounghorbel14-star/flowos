import { and, asc, count, desc, eq, ilike, inArray, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { TaskPriority, TaskStatus } from "@shared/domain";
import type { Database, Tx } from "../../db/client";
import { employees, organizations, projects, taskComments, tasks, users } from "../../db/schema";
import { assertCan, can, type Actor } from "../../lib/actor";
import { audit, diff } from "../../lib/audit";
import { todayISO } from "../../lib/dates";
import { badRequest, forbidden, notFound } from "../../lib/errors";
import { likePattern, offsetOf, toPage, type PageInput } from "../../lib/pagination";
import { fullName, requireEmployee, requireProject } from "../../lib/refs";
import { entityHistory } from "../audit/service";
import { myEmployee } from "../employees/service";
import { notify } from "../notifications/service";

export interface TaskInput {
  title: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  projectId?: string | null;
  assigneeEmployeeId?: string | null;
  dueDate?: string | null;
}

export interface TaskListInput extends PageInput {
  search?: string;
  statuses?: TaskStatus[];
  priorities?: TaskPriority[];
  projectId?: string;
  assigneeEmployeeId?: string;
  unassigned?: boolean;
  mine?: boolean;
  overdue?: boolean;
  sort: "recent" | "due" | "priority" | "updated";
}

const PRIORITY_ORDER = sql`case ${tasks.priority} when 'URGENT' then 0 when 'HIGH' then 1 when 'MEDIUM' then 2 else 3 end`;

const columns = {
  id: tasks.id,
  number: tasks.number,
  title: tasks.title,
  description: tasks.description,
  status: tasks.status,
  priority: tasks.priority,
  dueDate: tasks.dueDate,
  completedAt: tasks.completedAt,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
  createdByUserId: tasks.createdByUserId,
  projectId: tasks.projectId,
  projectName: projects.name,
  assigneeEmployeeId: tasks.assigneeEmployeeId,
  assigneeFirstName: employees.firstName,
  assigneeLastName: employees.lastName,
  assigneeUserId: employees.userId,
};

function baseQuery(db: Tx) {
  return db
    .select(columns)
    .from(tasks)
    .leftJoin(projects, and(eq(projects.orgId, tasks.orgId), eq(projects.id, tasks.projectId)))
    .leftJoin(employees, and(eq(employees.orgId, tasks.orgId), eq(employees.id, tasks.assigneeEmployeeId)));
}

export async function listTasks(db: Database, actor: Actor, input: TaskListInput) {
  assertCan(actor, "task:read");
  const filters: (SQL | undefined)[] = [eq(tasks.orgId, actor.orgId)];
  if (input.search) {
    const keyMatch = /^(?:[a-z]{2,6}-)?(\d{1,9})$/i.exec(input.search.trim());
    const p = likePattern(input.search);
    filters.push(
      or(
        ilike(tasks.title, p),
        ilike(tasks.description, p),
        keyMatch ? eq(tasks.number, Number(keyMatch[1])) : undefined,
      ),
    );
  }
  if (input.statuses?.length) filters.push(inArray(tasks.status, input.statuses));
  if (input.priorities?.length) filters.push(inArray(tasks.priority, input.priorities));
  if (input.projectId) filters.push(eq(tasks.projectId, input.projectId));
  if (input.assigneeEmployeeId) filters.push(eq(tasks.assigneeEmployeeId, input.assigneeEmployeeId));
  if (input.unassigned) filters.push(sql`${tasks.assigneeEmployeeId} is null`);
  if (input.mine) {
    const me = await myEmployee(db, actor);
    // No linked directory profile means nothing can be assigned to you.
    if (!me) return toPage([], 0, input);
    filters.push(eq(tasks.assigneeEmployeeId, me.id));
  }
  if (input.overdue) filters.push(and(ne(tasks.status, "DONE"), lt(tasks.dueDate, todayISO())));
  const where = and(...filters);

  const order =
    input.sort === "due"
      ? [sql`${tasks.dueDate} asc nulls last`, PRIORITY_ORDER]
      : input.sort === "priority"
        ? [PRIORITY_ORDER, sql`${tasks.dueDate} asc nulls last`]
        : input.sort === "updated"
          ? [desc(tasks.updatedAt)]
          : [desc(tasks.createdAt)];

  const [items, [total]] = await Promise.all([
    baseQuery(db)
      .where(where)
      .orderBy(...order, desc(tasks.number))
      .limit(input.pageSize)
      .offset(offsetOf(input)),
    db.select({ n: count() }).from(tasks).where(where),
  ]);
  return toPage(items, total?.n ?? 0, input);
}

async function loadTask(db: Tx, actor: Actor, id: string, lock = false) {
  const query = db
    .select()
    .from(tasks)
    .where(and(eq(tasks.orgId, actor.orgId), eq(tasks.id, id)));
  const [task] = lock ? await query.for("update") : await query.limit(1);
  if (!task) throw notFound("Task");
  return task;
}

/** May the actor modify this task? Anyone with write_any, or the assignee/creator with write_own. */
async function assertCanModify(
  db: Tx,
  actor: Actor,
  task: { createdByUserId: string | null; assigneeEmployeeId: string | null },
) {
  if (can(actor, "task:write_any")) return;
  if (!can(actor, "task:write_own")) throw forbidden();
  if (task.createdByUserId === actor.userId) return;
  if (task.assigneeEmployeeId) {
    const me = await myEmployee(db, actor);
    if (me && me.id === task.assigneeEmployeeId) return;
  }
  throw forbidden("You can only change tasks you created or that are assigned to you.");
}

export async function getTask(db: Database, actor: Actor, id: string) {
  assertCan(actor, "task:read");
  const [task] = await baseQuery(db)
    .where(and(eq(tasks.orgId, actor.orgId), eq(tasks.id, id)))
    .limit(1);
  if (!task) throw notFound("Task");
  const [comments, history, creator, org] = await Promise.all([
    db
      .select({
        id: taskComments.id,
        body: taskComments.body,
        createdAt: taskComments.createdAt,
        authorUserId: taskComments.authorUserId,
        authorName: users.name,
      })
      .from(taskComments)
      .leftJoin(users, eq(users.id, taskComments.authorUserId))
      .where(and(eq(taskComments.orgId, actor.orgId), eq(taskComments.taskId, id)))
      .orderBy(asc(taskComments.createdAt)),
    entityHistory(db, actor, "task", id, 50),
    task.createdByUserId
      ? db.select({ name: users.name }).from(users).where(eq(users.id, task.createdByUserId)).limit(1)
      : Promise.resolve([]),
    db
      .select({ prefix: organizations.taskPrefix })
      .from(organizations)
      .where(eq(organizations.id, actor.orgId)),
  ]);
  let canEdit = true;
  try {
    await assertCanModify(db, actor, task);
  } catch {
    canEdit = false;
  }
  return {
    ...task,
    key: `${org[0]?.prefix ?? "FLW"}-${task.number}`,
    createdByName: creator[0]?.name ?? null,
    comments,
    history,
    canEdit,
    canComment: can(actor, "task:comment"),
  };
}

async function validateRefs(tx: Tx, actor: Actor, input: Partial<TaskInput>) {
  let assignee: Awaited<ReturnType<typeof requireEmployee>> | undefined;
  if (input.projectId) {
    const project = await requireProject(tx, actor.orgId, input.projectId);
    if (project.status === "CANCELLED") throw badRequest("Cannot add tasks to a cancelled project.");
  }
  if (input.assigneeEmployeeId) {
    assignee = await requireEmployee(tx, actor.orgId, input.assigneeEmployeeId, "Assignee");
    if (assignee.status === "TERMINATED")
      throw badRequest("Tasks cannot be assigned to a terminated employee.");
  }
  return { assignee };
}

async function notifyAssignee(
  tx: Tx,
  actor: Actor,
  assignee: { userId: string | null } | undefined,
  task: { id: string; title: string },
) {
  if (!assignee?.userId) return;
  await notify(tx, {
    orgId: actor.orgId,
    userId: assignee.userId,
    actorUserId: actor.userId,
    type: "TASK_ASSIGNED",
    title: `You were assigned “${task.title}”`,
    link: `/tasks/${task.id}`,
  });
}

export async function createTask(db: Database, actor: Actor, input: TaskInput) {
  assertCan(actor, "task:create");
  return db.transaction(async (tx) => {
    const { assignee } = await validateRefs(tx, actor, input);
    // Row-locks the organization, serializing number allocation per tenant.
    const [seq] = await tx
      .update(organizations)
      .set({ taskSeq: sql`${organizations.taskSeq} + 1` })
      .where(eq(organizations.id, actor.orgId))
      .returning({ next: organizations.taskSeq });
    const status = input.status ?? "TODO";
    const [created] = await tx
      .insert(tasks)
      .values({
        ...input,
        status,
        orgId: actor.orgId,
        number: seq!.next,
        createdByUserId: actor.userId,
        completedAt: status === "DONE" ? new Date() : null,
      })
      .returning();
    await audit(tx, actor, {
      action: "task.created",
      entityType: "task",
      entityId: created!.id,
      summary: `Created task “${created!.title}”`,
      metadata: { projectId: created!.projectId, assigneeEmployeeId: created!.assigneeEmployeeId },
    });
    if (input.projectId) await touchProject(tx, actor.orgId, input.projectId);
    await notifyAssignee(tx, actor, assignee, created!);
    return created!;
  });
}

async function touchProject(tx: Tx, orgId: string, projectId: string) {
  await tx
    .update(projects)
    .set({ updatedAt: new Date() })
    .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)));
}

export async function updateTask(db: Database, actor: Actor, id: string, input: Partial<TaskInput>) {
  assertCan(actor, "task:read");
  return db.transaction(async (tx) => {
    const before = await loadTask(tx, actor, id, true);
    await assertCanModify(tx, actor, before);
    const { assignee } = await validateRefs(tx, actor, input);

    // completed_at follows status exactly; a DB check constraint enforces the same rule.
    let completedAt = before.completedAt;
    if (input.status && input.status !== before.status) {
      completedAt = input.status === "DONE" ? new Date() : null;
    }
    const [after] = await tx
      .update(tasks)
      .set({ ...input, completedAt, updatedAt: new Date() })
      .where(and(eq(tasks.orgId, actor.orgId), eq(tasks.id, id)))
      .returning();

    const changes = diff(before, input);
    const statusChanged = input.status !== undefined && input.status !== before.status;
    const reassigned =
      input.assigneeEmployeeId !== undefined && input.assigneeEmployeeId !== before.assigneeEmployeeId;
    await audit(tx, actor, {
      action: statusChanged ? "task.status_changed" : reassigned ? "task.reassigned" : "task.updated",
      entityType: "task",
      entityId: id,
      summary: statusChanged
        ? `Moved “${after!.title}” from ${before.status} to ${input.status}`
        : reassigned
          ? assignee
            ? `Assigned “${after!.title}” to ${fullName(assignee)}`
            : `Unassigned “${after!.title}”`
          : `Updated “${after!.title}”`,
      metadata: changes,
    });
    if (reassigned) await notifyAssignee(tx, actor, assignee, after!);
    for (const projectId of new Set([before.projectId, after!.projectId])) {
      if (projectId) await touchProject(tx, actor.orgId, projectId);
    }
    return after!;
  });
}

export async function deleteTask(db: Database, actor: Actor, id: string) {
  assertCan(actor, "task:read");
  return db.transaction(async (tx) => {
    const task = await loadTask(tx, actor, id, true);
    if (!can(actor, "task:write_any") && task.createdByUserId !== actor.userId) {
      throw forbidden("Only the task's creator or a manager can delete it.");
    }
    await tx.delete(tasks).where(and(eq(tasks.orgId, actor.orgId), eq(tasks.id, id)));
    await audit(tx, actor, {
      action: "task.deleted",
      entityType: "task",
      entityId: id,
      summary: `Deleted task “${task.title}”`,
      metadata: { number: task.number, projectId: task.projectId },
    });
    if (task.projectId) await touchProject(tx, actor.orgId, task.projectId);
    return { ok: true };
  });
}

export async function addComment(db: Database, actor: Actor, taskId: string, body: string) {
  assertCan(actor, "task:comment");
  return db.transaction(async (tx) => {
    const task = await loadTask(tx, actor, taskId);
    const [comment] = await tx
      .insert(taskComments)
      .values({ orgId: actor.orgId, taskId, authorUserId: actor.userId, body })
      .returning();
    await audit(tx, actor, {
      action: "task.commented",
      entityType: "task",
      entityId: taskId,
      summary: `Commented on “${task.title}”`,
      metadata: { commentId: comment!.id },
    });
    const recipients = new Set<string>();
    if (task.createdByUserId) recipients.add(task.createdByUserId);
    if (task.assigneeEmployeeId) {
      const [assignee] = await tx
        .select({ userId: employees.userId })
        .from(employees)
        .where(and(eq(employees.orgId, actor.orgId), eq(employees.id, task.assigneeEmployeeId)));
      if (assignee?.userId) recipients.add(assignee.userId);
    }
    for (const userId of recipients) {
      await notify(tx, {
        orgId: actor.orgId,
        userId,
        actorUserId: actor.userId,
        type: "TASK_COMMENTED",
        title: `New comment on “${task.title}”`,
        body: body.slice(0, 200),
        link: `/tasks/${taskId}`,
      });
    }
    return comment!;
  });
}

export async function deleteComment(db: Database, actor: Actor, commentId: string) {
  return db.transaction(async (tx) => {
    const [comment] = await tx
      .select()
      .from(taskComments)
      .where(and(eq(taskComments.orgId, actor.orgId), eq(taskComments.id, commentId)))
      .for("update");
    if (!comment) throw notFound("Comment");
    if (comment.authorUserId !== actor.userId && !can(actor, "task:write_any")) {
      throw forbidden("You can only delete your own comments.");
    }
    await tx
      .delete(taskComments)
      .where(and(eq(taskComments.orgId, actor.orgId), eq(taskComments.id, commentId)));
    await audit(tx, actor, {
      action: "task.comment_deleted",
      entityType: "task",
      entityId: comment.taskId,
      summary: "Deleted a comment",
      metadata: { commentId },
    });
    return { ok: true };
  });
}
