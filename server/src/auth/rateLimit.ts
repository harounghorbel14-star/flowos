import { AppError } from "../lib/errors";

/**
 * Fixed-window, in-memory rate limiter. Adequate for a single instance; a
 * multi-instance deployment must swap this for a shared store (see
 * docs/SECURITY.md).
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  consume(key: string, now = Date.now()): void {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      this.sweep(now);
      return;
    }
    entry.count++;
    if (entry.count > this.limit) {
      throw new AppError("TOO_MANY_REQUESTS", "Too many attempts. Please wait a moment and try again.");
    }
  }

  reset(): void {
    this.hits.clear();
  }

  private sweep(now: number) {
    if (this.hits.size < 10_000) return;
    for (const [key, value] of this.hits) if (value.resetAt <= now) this.hits.delete(key);
  }
}

export const loginLimiter = new RateLimiter(10, 60_000);
export const signupLimiter = new RateLimiter(5, 60_000);
