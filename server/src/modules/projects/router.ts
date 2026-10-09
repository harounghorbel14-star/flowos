import { z } from "zod";
import { PROJECT_STATUSES } from "@shared/domain";
import { pageInput } from "../../lib/pagination";
import { orgProcedure, router } from "../../trpc/trpc";
import * as service from "./service";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

const fields = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(5000).nullish(),
  status: z.enum(PROJECT_STATUSES).optional(),
  ownerEmployeeId: z.string().uuid().nullish(),
  startDate: isoDate.nullish(),
  dueDate: isoDate.nullish(),
  memberIds: z.array(z.string().uuid()).max(200).optional(),
});

export const projectsRouter = router({
  list: orgProcedure
    .input(
      pageInput.extend({
        search: z.string().trim().max(100).optional(),
        status: z.enum(PROJECT_STATUSES).optional(),
        ownerEmployeeId: z.string().uuid().optional(),
        sort: z.enum(["recent", "due", "name"]).default("recent"),
      }),
    )
    .query(({ ctx, input }) => service.listProjects(ctx.db, ctx.actor, input)),
  options: orgProcedure.query(({ ctx }) => service.projectOptions(ctx.db, ctx.actor)),
  get: orgProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => service.getProject(ctx.db, ctx.actor, input.id)),
  create: orgProcedure
    .input(fields)
    .mutation(({ ctx, input }) => service.createProject(ctx.db, ctx.actor, input)),
  update: orgProcedure
    .input(fields.partial().extend({ id: z.string().uuid() }))
    .mutation(({ ctx, input: { id, ...rest } }) => service.updateProject(ctx.db, ctx.actor, id, rest)),
  delete: orgProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => service.deleteProject(ctx.db, ctx.actor, input.id)),
});
