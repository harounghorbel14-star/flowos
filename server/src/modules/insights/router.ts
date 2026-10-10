import { z } from "zod";
import { orgProcedure, router } from "../../trpc/trpc";
import { operationalTrends, WEEK_RANGES } from "./service";

export const insightsRouter = router({
  trends: orgProcedure
    .input(
      z
        .object({
          weeks: z.union([z.literal(WEEK_RANGES[0]), z.literal(WEEK_RANGES[1]), z.literal(WEEK_RANGES[2])]),
        })
        .partial()
        .optional(),
    )
    .query(({ ctx, input }) => operationalTrends(ctx.db, ctx.actor, { weeks: input?.weeks })),
});
