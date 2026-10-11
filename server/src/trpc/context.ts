import type { Request, Response } from "express";
import { SESSION_COOKIE, validateSession, type AuthState } from "../auth/session";
import { getDb, type Database } from "../db/client";
import { isProduction } from "../env";

export interface Context {
  db: Database;
  ip: string | null;
  userAgent: string | null;
  /** Organization the client asked to act in. Untrusted until checked against memberships. */
  requestedOrgId: string | null;
  auth: AuthState | null;
  setSessionCookie(token: string, expiresAt: Date): void;
  clearSessionCookie(): void;
}

export async function createContext({ req, res }: { req: Request; res: Response }): Promise<Context> {
  const db = getDb();
  const token = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE];
  const auth = await validateSession(db, token);
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isProduction(),
    path: "/",
  };
  if (auth?.renewed && token) {
    // Only when the expiry moved: re-sending it on every response let a request still in
    // flight during sign-out put the (revoked) cookie back in the browser.
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions, expires: auth.expiresAt });
  }
  const orgHeader = req.header("x-flowos-org");
  return {
    db,
    ip: req.ip ?? null,
    userAgent: req.header("user-agent") ?? null,
    requestedOrgId: orgHeader && orgHeader.length <= 64 ? orgHeader : null,
    auth,
    setSessionCookie: (value, expiresAt) =>
      res.cookie(SESSION_COOKIE, value, { ...cookieOptions, expires: expiresAt }),
    clearSessionCookie: () => res.clearCookie(SESSION_COOKIE, cookieOptions),
  };
}
