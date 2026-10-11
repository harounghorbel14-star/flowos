import { z } from "zod";
import { authedProcedure, publicProcedure, router } from "../../trpc/trpc";
import * as service from "./service";

const password = z
  .string()
  .min(10, "Use at least 10 characters.")
  .max(200)
  .refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), "Use at least one letter and one number.");

export const authRouter = router({
  me: publicProcedure.query(async ({ ctx }) => {
    if (!ctx.auth) return null;
    const organizations = await service.listMyOrganizations(ctx.db, ctx.auth.user.id);
    return { user: ctx.auth.user, organizations };
  }),

  signup: publicProcedure
    .input(
      z.object({
        email: z.string().trim().email().max(254),
        name: z.string().trim().min(1).max(120),
        password,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { user, session } = await service.signup(ctx.db, input, { ip: ctx.ip, userAgent: ctx.userAgent });
      ctx.setSessionCookie(session.token, session.expiresAt);
      return { user };
    }),

  login: publicProcedure
    .input(z.object({ email: z.string().trim().max(254), password: z.string().max(200) }))
    .mutation(async ({ ctx, input }) => {
      const { user, session } = await service.login(ctx.db, input, { ip: ctx.ip, userAgent: ctx.userAgent });
      ctx.setSessionCookie(session.token, session.expiresAt);
      return { user };
    }),

  /** "Forgot password?": same answer for every email; see service.requestPasswordReset. */
  requestPasswordReset: publicProcedure
    .input(z.object({ email: z.string().trim().email().max(254) }))
    .mutation(async ({ ctx, input }) => {
      const { emailEnabled, delivery } = await service.requestPasswordReset(ctx.db, input, {
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      void delivery; // finishes after the response; failures are logged
      return { ok: true as const, emailEnabled };
    }),

  resetPassword: publicProcedure
    .input(z.object({ token: z.string().min(20).max(200), password }))
    .mutation(({ ctx, input }) =>
      service.resetPassword(ctx.db, input, { ip: ctx.ip, userAgent: ctx.userAgent }),
    ),

  changePassword: authedProcedure
    .input(z.object({ currentPassword: z.string().max(200), newPassword: password }))
    .mutation(({ ctx, input }) =>
      service.changePassword(ctx.db, { userId: ctx.auth.user.id, sessionId: ctx.auth.sessionId }, input, {
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      }),
    ),

  signOutOtherSessions: authedProcedure.mutation(({ ctx }) =>
    service.signOutOtherSessions(
      ctx.db,
      { userId: ctx.auth.user.id, sessionId: ctx.auth.sessionId },
      { ip: ctx.ip, userAgent: ctx.userAgent },
    ),
  ),

  logout: authedProcedure.mutation(async ({ ctx }) => {
    await service.logout(ctx.db, ctx.auth.sessionId);
    ctx.clearSessionCookie();
    return { ok: true };
  }),
});
