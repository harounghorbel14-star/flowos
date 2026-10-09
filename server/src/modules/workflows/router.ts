import { z } from "zod";
import { actionSchema, conditionSchema, TRIGGER_TYPES, WORKFLOW_LIMITS } from "@shared/workflows";
import { pageInput } from "../../lib/pagination";
import { orgProcedure, router } from "../../trpc/trpc";
import * as service from "./service";

const fields = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullish(),
  enabled: z.boolean().optional(),
  trigger: z
    .enum(TRIGGER_TYPES as [string, ...string[]])
    .transform((t) => t as (typeof TRIGGER_TYPES)[number]),
  conditions: z.array(conditionSchema).max(WORKFLOW_LIMITS.conditions).default([]),
  actions: z.array(actionSchema).min(1).max(WORKFLOW_LIMITS.actions),
});

export const workflowsRouter = router({
  list: orgProcedure.query(({ ctx }) => service.listWorkflows(ctx.db, ctx.actor)),
  get: orgProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => service.getWorkflow(ctx.db, ctx.actor, input.id)),
  create: orgProcedure
    .input(fields)
    .mutation(({ ctx, input }) => service.createWorkflow(ctx.db, ctx.actor, input)),
  update: orgProcedure
    .input(fields.partial().extend({ id: z.string().uuid() }))
    .mutation(({ ctx, input: { id, ...rest } }) => service.updateWorkflow(ctx.db, ctx.actor, id, rest)),
  delete: orgProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => service.deleteWorkflow(ctx.db, ctx.actor, input.id)),
  runs: orgProcedure
    .input(pageInput.extend({ workflowId: z.string().uuid() }))
    .query(({ ctx, input: { workflowId, ...page } }) =>
      service.listRuns(ctx.db, ctx.actor, workflowId, page),
    ),
  retryRun: orgProcedure
    .input(z.object({ runId: z.string().uuid() }))
    .mutation(({ ctx, input }) => service.retryRun(ctx.db, ctx.actor, input.runId)),
});
