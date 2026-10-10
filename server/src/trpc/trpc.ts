import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import type { Permission } from "@shared/permissions";
import { isProduction } from "../env";
import { assertCan } from "../lib/actor";
import { loadActor } from "../lib/membership";
import { toTRPCError } from "../lib/errors";
import { logSafeError } from "../lib/logging";
import type { Context } from "./context";

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    const isInternal = error.code === "INTERNAL_SERVER_ERROR";
    if (isInternal) console.error("[trpc] internal error:", logSafeError(error.cause ?? error));
    return {
      ...shape,
      message: isInternal && isProduction() ? "Something went wrong. Please try again." : shape.message,
      data: {
        code: shape.data.code,
        httpStatus: shape.data.httpStatus,
        fieldErrors: error.cause instanceof ZodError ? error.cause.flatten().fieldErrors : undefined,
        stack: isProduction() ? undefined : shape.data.stack,
      },
    };
  },
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;

/** Translate domain and database errors into precise tRPC errors. */
const mapErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok) {
    const mapped = toTRPCError(result.error.cause);
    if (mapped) throw mapped;
  }
  return result;
});

export const publicProcedure = t.procedure.use(mapErrors);

export const authedProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.auth) throw new TRPCError({ code: "UNAUTHORIZED", message: "Please sign in." });
  return next({ ctx: { ...ctx, auth: ctx.auth } });
});

/**
 * Resolves the active organization from the `x-flowos-org` header and
 * verifies membership in the database on every request. The resulting
 * `actor` is the only tenant context services accept.
 */
export const orgProcedure = authedProcedure.use(async ({ ctx, next }) => {
  const { actor, reason } = await loadActor(ctx.db, ctx.auth.user.id, ctx.requestedOrgId, ctx.ip);
  if (!actor) {
    if (reason === "NO_ORG")
      throw new TRPCError({ code: "BAD_REQUEST", message: "No organization selected." });
    // Same response whether the org does not exist or the user is not a member.
    throw new TRPCError({ code: "FORBIDDEN", message: "You are not a member of this organization." });
  }
  return next({ ctx: { ...ctx, actor } });
});

/** orgProcedure that additionally requires a permission before the resolver runs. */
export function permitted(permission: Permission) {
  return orgProcedure.use(({ ctx, next }) => {
    assertCan(ctx.actor, permission);
    return next();
  });
}
