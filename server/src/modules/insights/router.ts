import { orgProcedure, router } from "../../trpc/trpc";
import { operationalTrends } from "./service";

export const insightsRouter = router({
  trends: orgProcedure.query(({ ctx }) => operationalTrends(ctx.db, ctx.actor)),
});
