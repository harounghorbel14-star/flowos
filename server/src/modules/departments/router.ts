import { z } from "zod";
import { orgProcedure, router } from "../../trpc/trpc";
import * as service from "./service";

const fields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullish(),
};

export const departmentsRouter = router({
  list: orgProcedure.query(({ ctx }) => service.listDepartments(ctx.db, ctx.actor)),
  create: orgProcedure
    .input(z.object(fields))
    .mutation(({ ctx, input }) => service.createDepartment(ctx.db, ctx.actor, input)),
  update: orgProcedure
    .input(z.object({ id: z.string().uuid(), ...fields, name: fields.name.optional() }))
    .mutation(({ ctx, input: { id, ...rest } }) => service.updateDepartment(ctx.db, ctx.actor, id, rest)),
  delete: orgProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => service.deleteDepartment(ctx.db, ctx.actor, input.id)),
});
