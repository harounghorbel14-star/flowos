import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { purgeExpiredRateLimits, RateLimiter } from "../src/auth/rateLimit";
import { rateLimits } from "../src/db/schema";
import { db } from "./helpers";

describe("shared rate limiter", () => {
  it("shares counters across limiter instances (i.e. across API processes)", async () => {
    const name = `t-${randomUUID().slice(0, 8)}`;
    const instanceA = new RateLimiter(name, 3, 60_000);
    const instanceB = new RateLimiter(name, 3, 60_000);
    await instanceA.consume("1.2.3.4");
    await instanceB.consume("1.2.3.4");
    await instanceA.consume("1.2.3.4");
    await expect(instanceB.consume("1.2.3.4")).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    // Other identifiers are unaffected.
    await expect(instanceA.consume("5.6.7.8")).resolves.toBeUndefined();
  });

  it("counts concurrent hits exactly", async () => {
    const limiter = new RateLimiter(`c-${randomUUID().slice(0, 8)}`, 10, 60_000);
    const results = await Promise.allSettled(Array.from({ length: 25 }, () => limiter.consume("burst")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
  });

  it("opens a new window after expiry and stores only hashed keys", async () => {
    const name = `w-${randomUUID().slice(0, 8)}`;
    const limiter = new RateLimiter(name, 1, 60_000);
    const email = `secret-${randomUUID()}@example.test`;
    await limiter.consume(email);
    await expect(limiter.consume(email)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    const rows = await db()
      .select()
      .from(rateLimits)
      .where(sql`${rateLimits.key} like ${`${name}:%`}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toMatch(new RegExp(`^${name}:[0-9a-f]{64}$`));
    expect(JSON.stringify(rows)).not.toContain(email);

    await db().execute(
      sql`update rate_limits set reset_at = now() - interval '1 second' where key like ${`${name}:%`}`,
    );
    await expect(limiter.consume(email)).resolves.toBeUndefined();
  });

  it("purges expired windows", async () => {
    const name = `p-${randomUUID().slice(0, 8)}`;
    await new RateLimiter(name, 5, 60_000).consume("x");
    await db().execute(
      sql`update rate_limits set reset_at = now() - interval '1 second' where key like ${`${name}:%`}`,
    );
    expect(await purgeExpiredRateLimits(db())).toBeGreaterThanOrEqual(1);
    expect(
      await db()
        .select()
        .from(rateLimits)
        .where(sql`${rateLimits.key} like ${`${name}:%`}`),
    ).toHaveLength(0);
  });
});
