import { z } from "zod";
import { EMPLOYEE_STATUSES, EMPLOYMENT_TYPES } from "@shared/domain";
import { pageInput } from "../../lib/pagination";
import { orgProcedure, router } from "../../trpc/trpc";
import * as service from "./service";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

const fields = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254),
  jobTitle: optionalText(120),
  phone: optionalText(40),
  location: optionalText(120),
  departmentId: z.string().uuid().nullish(),
  managerId: z.string().uuid().nullish(),
  userId: z.string().uuid().nullish(),
  status: z.enum(EMPLOYEE_STATUSES).optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  startDate: isoDate.nullish(),
  endDate: isoDate.nullish(),
});

export const employeesRouter = router({
  list: orgProcedure
    .input(
      pageInput.extend({
        search: z.string().trim().max(100).optional(),
        departmentId: z.string().uuid().optional(),
        status: z.enum(EMPLOYEE_STATUSES).optional(),
        managerId: z.string().uuid().optional(),
        sort: z.enum(["name", "recent", "startDate"]).default("name"),
      }),
    )
    .query(({ ctx, input }) => service.listEmployees(ctx.db, ctx.actor, input)),

  options: orgProcedure
    .input(z.object({ includeTerminated: z.boolean().default(false) }).optional())
    .query(({ ctx, input }) => service.employeeOptions(ctx.db, ctx.actor, input?.includeTerminated)),

  get: orgProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => service.getEmployee(ctx.db, ctx.actor, input.id)),

  me: orgProcedure.query(({ ctx }) => service.myEmployee(ctx.db, ctx.actor)),

  create: orgProcedure
    .input(fields)
    .mutation(({ ctx, input }) => service.createEmployee(ctx.db, ctx.actor, input)),

  update: orgProcedure
    .input(fields.partial().extend({ id: z.string().uuid() }))
    .mutation(({ ctx, input: { id, ...rest } }) => service.updateEmployee(ctx.db, ctx.actor, id, rest)),
});
