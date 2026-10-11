import { and, eq, isNull, lt, or, isNotNull } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import { passwordResetTokens } from "../db/schema";
import { env } from "../env";
import { generateToken, hashToken } from "../lib/tokens";

export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * A new single-use reset link for the user. Any earlier unused link stops working,
 * so only the most recent email is valid. The link is built from APP_ORIGIN, never
 * from request headers.
 */
export async function createResetLink(db: Tx, userId: string): Promise<{ url: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await db
    .delete(passwordResetTokens)
    .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
  await db.insert(passwordResetTokens).values({ userId, tokenHash: hashToken(token), expiresAt });
  return { url: `${env().APP_ORIGIN}/reset-password/${token}`, expiresAt };
}

/** Delete links that expired or were used more than a day ago. */
export async function purgeOldResetTokens(db: Database): Promise<number> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await db
    .delete(passwordResetTokens)
    .where(
      or(
        lt(passwordResetTokens.expiresAt, dayAgo),
        and(isNotNull(passwordResetTokens.usedAt), lt(passwordResetTokens.usedAt, dayAgo)),
      ),
    );
  return result.rowCount ?? 0;
}
