import { z } from "zod";
import { orgProcedure, router } from "../../trpc/trpc";
import * as assistant from "./assistant";

export const aiRouter = router({
  status: orgProcedure.query(() => assistant.aiStatus()),
  conversations: orgProcedure.query(({ ctx }) => assistant.listConversations(ctx.db, ctx.actor)),
  createConversation: orgProcedure
    .input(z.object({ title: z.string().max(120).optional() }))
    .mutation(({ ctx, input }) => assistant.createConversation(ctx.db, ctx.actor, input.title)),
  conversation: orgProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => assistant.getConversation(ctx.db, ctx.actor, input.id)),
  deleteConversation: orgProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => assistant.deleteConversation(ctx.db, ctx.actor, input.id)),
  // Confirmation is a separate, user-initiated request. Nothing the model writes can trigger it.
  confirmAction: orgProcedure
    .input(z.object({ actionId: z.string().uuid(), inputHash: z.string().regex(/^[0-9a-f]{64}$/) }))
    .mutation(({ ctx, input }) => assistant.confirmAction(ctx.db, ctx.actor, input)),
  rejectAction: orgProcedure
    .input(z.object({ actionId: z.string().uuid() }))
    .mutation(({ ctx, input }) => assistant.rejectAction(ctx.db, ctx.actor, input.actionId)),
});
