import { z } from "zod";
import { INTEGRATION_IDS } from "@shared/integrations";
import { orgProcedure, router } from "../../trpc/trpc";
import { connectIntegration, disconnectIntegration, listIntegrations, sendTestMessage } from "./service";

const provider = z.enum(INTEGRATION_IDS);

export const integrationsRouter = router({
  list: orgProcedure.query(({ ctx }) => listIntegrations(ctx.db, ctx.actor)),
  connect: orgProcedure
    .input(z.object({ provider, webhookUrl: z.string().trim().max(2000) }))
    .mutation(({ ctx, input }) => connectIntegration(ctx.db, ctx.actor, input)),
  disconnect: orgProcedure
    .input(z.object({ provider }))
    .mutation(({ ctx, input }) => disconnectIntegration(ctx.db, ctx.actor, input.provider)),
  test: orgProcedure
    .input(z.object({ provider }))
    .mutation(({ ctx, input }) => sendTestMessage(ctx.db, ctx.actor, input.provider)),
});
