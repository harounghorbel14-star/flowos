import { and, eq, lt, ne } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import { sessions, users } from "../db/schema";
import { generateToken, hashToken } from "../lib/tokens";

export const SESSION_COOKIE = "flowos_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RENEW_WHEN_REMAINING_MS = 15 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
/** Sliding renewal never extends a session beyond this age: sign in again after 90 days. */
export const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export interface AuthState {
  sessionId: string;
  expiresAt: Date;
  user: SessionUser;
  /** True when this request moved the expiry forward, so the cookie must follow. */
  renewed?: boolean;
}

export async function createSession(
  db: Database,
  userId: string,
  meta: { ip: string | null; userAgent: string | null },
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    id: hashToken(token),
    userId,
    expiresAt,
    ip: meta.ip,
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
  });
  return { token, expiresAt };
}

/** Resolve a raw cookie token to a live session, renewing it when it is close to expiry. */
export async function validateSession(
  db: Database,
  token: string | null | undefined,
): Promise<AuthState | null> {
  if (!token || token.length > 100) return null;
  const sessionId = hashToken(token);
  const [row] = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      createdAt: sessions.createdAt,
      user: { id: users.id, email: users.email, name: users.name },
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) return null;

  const now = Date.now();
  const hardLimit = row.createdAt.getTime() + SESSION_MAX_AGE_MS;
  if (row.expiresAt.getTime() <= now || hardLimit <= now) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    return null;
  }

  let expiresAt = row.expiresAt;
  let renewed = false;
  if (expiresAt.getTime() - now < RENEW_WHEN_REMAINING_MS && expiresAt.getTime() < hardLimit) {
    expiresAt = new Date(Math.min(now + SESSION_TTL_MS, hardLimit));
    renewed = true;
    await db.update(sessions).set({ expiresAt, lastSeenAt: new Date() }).where(eq(sessions.id, sessionId));
  } else if (now - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, sessionId));
  }
  return { sessionId, expiresAt, user: row.user, renewed };
}

export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/** Sign the user out everywhere except the given session (password change, "sign out other devices"). */
export async function revokeOtherSessions(db: Tx, userId: string, keepSessionId: string): Promise<number> {
  const result = await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)));
  return result.rowCount ?? 0;
}

/** Sign the user out everywhere (password reset by email link). */
export async function revokeAllSessions(db: Tx, userId: string): Promise<number> {
  const result = await db.delete(sessions).where(eq(sessions.userId, userId));
  return result.rowCount ?? 0;
}

/** Delete expired sessions (they are already rejected on use). */
export async function purgeExpiredSessions(db: Database): Promise<number> {
  const result = await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  return result.rowCount ?? 0;
}
