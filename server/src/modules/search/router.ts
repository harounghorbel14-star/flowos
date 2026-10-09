import { z } from "zod";
import { orgProcedure, router } from "../../trpc/trpc";
import { globalSearch } from "./service";

export const searchRouter = router({
  global: orgProcedure
    .input(z.object({ q: z.string().max(100) }))
    .query(({ ctx, input }) => globalSearch(ctx.db, ctx.actor, input.q)),
});
