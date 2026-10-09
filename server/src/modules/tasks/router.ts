import { z } from "zod";
import { TASK_PRIORITIES, TASK_STATUSES } from "@shared/domain";
import { pageInput } from "../../lib/pagination";
import { orgProcedure, router } from "../../trpc/trpc";
import * as service from "./service";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

const fields = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10_000).nullish(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  projectId: z.string().uuid().nullish(),
  assigneeEmployeeId: z.string().uuid().nullish(),
  dueDate: isoDate.nullish(),
});

export const tasksRouter = router({
  list: orgProcedure
    .input(
      pageInput.extend({
        search: z.string().trim().max(100).optional(),
        statuses: z.array(z.enum(TASK_STATUSES)).max(5).optional(),
        priorities: z.array(z.enum(TASK_PRIORITIES)).max(4).optional(),
        projectId: z.string().uuid().optional(),
        assigneeEmployeeId: z.string().uuid().optional(),
        unassigned: z.boolean().optional(),
        mine: z.boolean().optional(),
        overdue: z.boolean().optional(),
        sort: z.enum(["recent", "due", "priority", "updated"]).default("recent"),
      }),
    )
    .query(({ ctx, input }) => service.listTasks(ctx.db, ctx.actor, input)),
  get: orgProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => service.getTask(ctx.db, ctx.actor, input.id)),
  create: orgProcedure
    .input(fields)
    .mutation(({ ctx, input }) => service.createTask(ctx.db, ctx.actor, input)),
  update: orgProcedure
    .input(fields.partial().extend({ id: z.string().uuid() }))
    .mutation(({ ctx, input: { id, ...rest } }) => service.updateTask(ctx.db, ctx.actor, id, rest)),
  delete: orgProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => service.deleteTask(ctx.db, ctx.actor, input.id)),
  addComment: orgProcedure
    .input(z.object({ taskId: z.string().uuid(), body: z.string().trim().min(1).max(5000) }))
    .mutation(({ ctx, input }) => service.addComment(ctx.db, ctx.actor, input.taskId, input.body)),
  deleteComment: orgProcedure
    .input(z.object({ commentId: z.string().uuid() }))
    .mutation(({ ctx, input }) => service.deleteComment(ctx.db, ctx.actor, input.commentId)),
});
