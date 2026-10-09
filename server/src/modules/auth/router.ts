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

  logout: authedProcedure.mutation(async ({ ctx }) => {
    await service.logout(ctx.db, ctx.auth.sessionId);
    ctx.clearSessionCookie();
    return { ok: true };
  }),
});
