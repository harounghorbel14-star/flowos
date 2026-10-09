import { TRPCError } from "@trpc/server";

/**
 * Domain errors thrown by services. They carry safe, user-facing messages and
 * are mapped onto tRPC codes in one place.
 */
export class AppError extends Error {
  constructor(
    public readonly code:
      "BAD_REQUEST" | "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "TOO_MANY_REQUESTS",
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string) => new AppError("BAD_REQUEST", message);
export const forbidden = (message = "You do not have permission to do that.") =>
  new AppError("FORBIDDEN", message);
/** Used for both "missing" and "belongs to another organization" so IDs leak nothing. */
export const notFound = (entity = "Record") => new AppError("NOT_FOUND", `${entity} not found.`);
export const conflict = (message: string) => new AppError("CONFLICT", message);

export function toTRPCError(err: unknown): TRPCError | undefined {
  if (err instanceof AppError) return new TRPCError({ code: err.code, message: err.message });
  // Postgres unique violation that escaped service-level checks (e.g. a race).
  if (isPgError(err, "23505"))
    return new TRPCError({ code: "CONFLICT", message: "That record already exists." });
  // Foreign key violation: a referenced record is missing or in another tenant.
  if (isPgError(err, "23503"))
    return new TRPCError({ code: "BAD_REQUEST", message: "A referenced record is invalid." });
  return undefined;
}

export function isPgError(err: unknown, code: string): boolean {
  let current: unknown = err;
  // drizzle wraps driver errors; walk the cause chain.
  for (let i = 0; i < 4 && current; i++) {
    if (typeof current === "object" && current !== null && (current as { code?: unknown }).code === code)
      return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
