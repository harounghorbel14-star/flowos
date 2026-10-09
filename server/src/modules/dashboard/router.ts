import { orgProcedure, router } from "../../trpc/trpc";
import { commandCenter } from "./service";

export const dashboardRouter = router({
  commandCenter: orgProcedure.query(({ ctx }) => commandCenter(ctx.db, ctx.actor)),
});
