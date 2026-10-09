import { z } from "zod";
import { pageInput } from "../../lib/pagination";
import { orgProcedure, router } from "../../trpc/trpc";
import * as service from "./service";

export const notificationsRouter = router({
  list: orgProcedure
    .input(pageInput.extend({ unreadOnly: z.boolean().default(false) }))
    .query(({ ctx, input }) => service.listNotifications(ctx.db, ctx.actor, input)),
  unreadCount: orgProcedure.query(({ ctx }) => service.unreadCount(ctx.db, ctx.actor)),
  markRead: orgProcedure
    .input(z.object({ ids: z.array(z.string().uuid()).max(100).optional() }))
    .mutation(({ ctx, input }) => service.markRead(ctx.db, ctx.actor, input.ids)),
});
