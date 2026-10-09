import { z } from "zod";
import { ROLES } from "@shared/domain";
import { authedProcedure, orgProcedure, publicProcedure, router } from "../../trpc/trpc";
import * as service from "./service";

const token = z.string().min(20).max(100);

export const orgsRouter = router({
  create: authedProcedure
    .input(
      z.object({
        name: z.string().trim().min(2).max(80),
        addMeAsEmployee: z.boolean().default(true),
        jobTitle: z.string().trim().max(120).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => service.createOrganization(ctx.db, ctx.auth.user, input, ctx.ip)),

  current: orgProcedure.query(({ ctx }) => service.getOrganization(ctx.db, ctx.actor)),

  update: orgProcedure
    .input(
      z.object({
        name: z.string().trim().min(2).max(80).optional(),
        taskPrefix: z
          .string()
          .trim()
          .regex(/^[A-Z]{2,6}$/, "Use 2–6 capital letters.")
          .optional(),
      }),
    )
    .mutation(({ ctx, input }) => service.updateOrganization(ctx.db, ctx.actor, input)),

  members: orgProcedure.query(({ ctx }) => service.listMembers(ctx.db, ctx.actor)),

  changeRole: orgProcedure
    .input(z.object({ membershipId: z.string().uuid(), role: z.enum(ROLES) }))
    .mutation(({ ctx, input }) => service.changeRole(ctx.db, ctx.actor, input)),

  removeMember: orgProcedure
    .input(z.object({ membershipId: z.string().uuid() }))
    .mutation(({ ctx, input }) => service.removeMember(ctx.db, ctx.actor, input.membershipId)),

  leave: orgProcedure.mutation(({ ctx }) => service.leaveOrganization(ctx.db, ctx.actor)),

  invitations: orgProcedure.query(({ ctx }) => service.listInvitations(ctx.db, ctx.actor)),

  invite: orgProcedure
    .input(z.object({ email: z.string().trim().email().max(254), role: z.enum(ROLES) }))
    .mutation(({ ctx, input }) => service.createInvitation(ctx.db, ctx.actor, input)),

  revokeInvitation: orgProcedure
    .input(z.object({ invitationId: z.string().uuid() }))
    .mutation(({ ctx, input }) => service.revokeInvitation(ctx.db, ctx.actor, input.invitationId)),

  previewInvitation: publicProcedure
    .input(z.object({ token }))
    .query(({ ctx, input }) => service.previewInvitation(ctx.db, input.token)),

  acceptInvitation: authedProcedure
    .input(z.object({ token }))
    .mutation(({ ctx, input }) => service.acceptInvitation(ctx.db, ctx.auth.user, input.token, ctx.ip)),
});
