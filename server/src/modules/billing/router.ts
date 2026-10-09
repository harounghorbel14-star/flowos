import { z } from "zod";
import { orgProcedure, router } from "../../trpc/trpc";
import { billingStatus, openPortal, startCheckout } from "./service";

export const billingRouter = router({
  status: orgProcedure.query(({ ctx }) => billingStatus(ctx.db, ctx.actor)),
  checkout: orgProcedure
    .input(z.object({ plan: z.enum(["TEAM", "BUSINESS"]) }))
    .mutation(({ ctx, input }) => startCheckout(ctx.db, ctx.actor, input.plan)),
  portal: orgProcedure.mutation(({ ctx }) => openPortal(ctx.db, ctx.actor)),
});
