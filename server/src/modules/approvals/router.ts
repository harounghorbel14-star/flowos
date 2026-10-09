import { z } from "zod";
import { APPROVAL_STATUSES, APPROVAL_TYPES } from "@shared/domain";
import { pageInput } from "../../lib/pagination";
import { orgProcedure, router } from "../../trpc/trpc";
import * as service from "./service";

export const approvalsRouter = router({
  list: orgProcedure
    .input(
      pageInput.extend({
        box: z.enum(["inbox", "outbox", "all"]).default("inbox"),
        status: z.enum(APPROVAL_STATUSES).optional(),
        type: z.enum(APPROVAL_TYPES).optional(),
      }),
    )
    .query(({ ctx, input }) => service.listRequests(ctx.db, ctx.actor, input)),
  get: orgProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => service.getRequest(ctx.db, ctx.actor, input.id)),
  approvers: orgProcedure.query(({ ctx }) => service.approverOptions(ctx.db, ctx.actor)),
  create: orgProcedure
    .input(
      z.object({
        type: z.enum(APPROVAL_TYPES),
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().max(5000).nullish(),
        approverUserId: z.string().uuid(),
        payload: z.record(z.unknown()).default({}),
      }),
    )
    .mutation(({ ctx, input }) => service.createRequest(ctx.db, ctx.actor, input)),
  decide: orgProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        decision: z.enum(["APPROVED", "REJECTED"]),
        comment: z.string().trim().max(2000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => service.decide(ctx.db, ctx.actor, input)),
  cancel: orgProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => service.cancel(ctx.db, ctx.actor, input.id)),
  comment: orgProcedure
    .input(z.object({ id: z.string().uuid(), comment: z.string().trim().min(1).max(2000) }))
    .mutation(({ ctx, input }) => service.addComment(ctx.db, ctx.actor, input.id, input.comment)),
});
