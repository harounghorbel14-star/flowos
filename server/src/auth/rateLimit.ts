import { createHash } from "node:crypto";
import { lt, sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { rateLimits } from "../db/schema";
import { AppError } from "../lib/errors";

/**
 * Fixed-window rate limiter backed by PostgreSQL, so limits hold across every
 * API instance. Each hit is one atomic upsert; identifiers are hashed before
 * storage so the table never contains raw emails or IP addresses.
 */
export class RateLimiter {
  constructor(
    private readonly name: string,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  private keyFor(identifier: string) {
    return `${this.name}:${createHash("sha256").update(identifier).digest("hex")}`;
  }

  /** Count one hit; throws TOO_MANY_REQUESTS once the window's limit is exceeded. */
  async consume(identifier: string, db: Database = getDb()): Promise<void> {
    const window = `${this.windowMs} milliseconds`;
    const result = await db.execute<{ count: number }>(sql`
      insert into ${rateLimits} (key, count, reset_at)
      values (${this.keyFor(identifier)}, 1, now() + ${window}::interval)
      on conflict (key) do update set
        count    = case when ${rateLimits.resetAt} <= now() then 1 else ${rateLimits.count} + 1 end,
        reset_at = case when ${rateLimits.resetAt} <= now() then now() + ${window}::interval else ${rateLimits.resetAt} end
      returning count`);
    const count = Number(result.rows[0]?.count ?? 0);
    if (count > this.limit) {
      throw new AppError("TOO_MANY_REQUESTS", "Too many attempts. Please wait a moment and try again.");
    }
  }

  /** Test hook: clear this limiter's counters. */
  async reset(db: Database = getDb()): Promise<void> {
    await db.execute(sql`delete from ${rateLimits} where key like ${`${this.name}:%`}`);
  }
}

/** Remove expired windows; called from the worker. */
export async function purgeExpiredRateLimits(db: Database): Promise<number> {
  const deleted = await db
    .delete(rateLimits)
    .where(lt(rateLimits.resetAt, new Date()))
    .returning({ key: rateLimits.key });
  return deleted.length;
}

export const loginLimiter = new RateLimiter("login", 10, 60_000);
export const signupLimiter = new RateLimiter("signup", 5, 60_000);
/** "Forgot password?" requests, per IP and per email: 5 per 15 minutes. */
export const passwordResetLimiter = new RateLimiter("password_reset", 5, 15 * 60_000);
