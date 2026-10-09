import { z } from "zod";
import { DOCUMENT_CATEGORIES } from "@shared/domain";
import { pageInput } from "../../lib/pagination";
import { orgProcedure, router } from "../../trpc/trpc";
import { documentMeta } from "./schemas";
import * as service from "./service";

export const documentsRouter = router({
  list: orgProcedure
    .input(
      pageInput.extend({
        search: z.string().trim().max(100).optional(),
        category: z.enum(DOCUMENT_CATEGORIES).optional(),
        employeeId: z.string().uuid().optional(),
        expiring: z.boolean().optional(),
      }),
    )
    .query(({ ctx, input }) => service.listDocuments(ctx.db, ctx.actor, input)),
  update: orgProcedure
    .input(documentMeta.partial().extend({ id: z.string().uuid() }))
    .mutation(({ ctx, input: { id, ...rest } }) => service.updateDocument(ctx.db, ctx.actor, id, rest)),
  delete: orgProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => service.deleteDocument(ctx.db, ctx.actor, input.id)),
});
