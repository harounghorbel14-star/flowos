import { z } from "zod";
import { pageInput } from "../../lib/pagination";
import { orgProcedure, router } from "../../trpc/trpc";
import * as service from "./service";

export const auditRouter = router({
  list: orgProcedure
    .input(
      pageInput.extend({
        entityType: z.string().max(40).optional(),
        actorUserId: z.string().uuid().optional(),
      }),
    )
    .query(({ ctx, input }) => service.listAuditEvents(ctx.db, ctx.actor, input)),
});
