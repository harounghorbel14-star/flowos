import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getDummyHash, hashPassword, verifyPassword } from "../../auth/password";
import { createResetLink } from "../../auth/passwordReset";
import { loginLimiter, passwordResetLimiter, signupLimiter } from "../../auth/rateLimit";
import { createSession, revokeAllSessions, revokeOtherSessions, revokeSession } from "../../auth/session";
import type { Database } from "../../db/client";
import { memberships, organizations, passwordResetTokens, users } from "../../db/schema";
import { audit } from "../../lib/audit";
import { AppError, conflict } from "../../lib/errors";
import { logSafeError } from "../../lib/logging";
import { getMailer, type Mailer } from "../../lib/mail";
import { hashToken } from "../../lib/tokens";

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

export async function signup(
  db: Database,
  input: { email: string; name: string; password: string },
  meta: RequestMeta,
) {
  await signupLimiter.consume(`ip:${meta.ip ?? "unknown"}`, db);
  const email = normalizeEmail(input.email);
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.email})`, email))
    .limit(1);
  if (existing.length > 0) throw conflict("An account with this email already exists.");

  const passwordHash = await hashPassword(input.password);
  const user = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(users)
      .values({ email, name: input.name.trim(), passwordHash })
      .returning({ id: users.id, email: users.email, name: users.name });
    await audit(
      tx,
      { userId: created!.id, orgId: null, ip: meta.ip },
      {
        action: "user.signed_up",
        entityType: "user",
        entityId: created!.id,
        summary: "Account created",
      },
    );
    return created!;
  });
  const session = await createSession(db, user.id, meta);
  return { user, session };
}

export async function login(db: Database, input: { email: string; password: string }, meta: RequestMeta) {
  const email = normalizeEmail(input.email);
  await loginLimiter.consume(`ip:${meta.ip ?? "unknown"}`, db);
  await loginLimiter.consume(`email:${email}`, db);
  const [user] = await db
    .select({ id: users.id, email: users.email, name: users.name, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(sql`lower(${users.email})`, email))
    .limit(1);
  // Always run a hash comparison so response time does not reveal whether the email exists.
  const valid = await verifyPassword(input.password, user?.passwordHash ?? (await getDummyHash()));
  if (!user || !valid) throw new AppError("UNAUTHORIZED", "Incorrect email or password.");

  const session = await createSession(db, user.id, meta);
  await audit(
    db,
    { userId: user.id, orgId: null, ip: meta.ip },
    {
      action: "user.logged_in",
      entityType: "user",
      entityId: user.id,
      summary: "Signed in",
    },
  );
  return { user: { id: user.id, email: user.email, name: user.name }, session };
}

export async function logout(db: Database, sessionId: string) {
  await revokeSession(db, sessionId);
}

/** Change password after re-verifying the current one; every other session is signed out. */
export async function changePassword(
  db: Database,
  auth: { userId: string; sessionId: string },
  input: { currentPassword: string; newPassword: string },
  meta: RequestMeta,
) {
  await loginLimiter.consume(`user:${auth.userId}`, db);
  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, auth.userId));
  if (!user || !(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw new AppError("BAD_REQUEST", "Your current password is incorrect.");
  }
  if (input.currentPassword === input.newPassword) {
    throw new AppError("BAD_REQUEST", "Choose a password different from your current one.");
  }
  const passwordHash = await hashPassword(input.newPassword);
  const signedOut = await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, auth.userId));
    await audit(
      tx,
      { userId: auth.userId, orgId: null, ip: meta.ip },
      {
        action: "user.password_changed",
        entityType: "user",
        entityId: auth.userId,
        summary: "Changed password",
      },
    );
    return revokeOtherSessions(tx, auth.userId, auth.sessionId);
  });
  return { ok: true as const, otherSessionsSignedOut: signedOut };
}

/** "Sign out other devices". */
export async function signOutOtherSessions(
  db: Database,
  auth: { userId: string; sessionId: string },
  meta: RequestMeta,
) {
  const signedOut = await revokeOtherSessions(db, auth.userId, auth.sessionId);
  await audit(
    db,
    { userId: auth.userId, orgId: null, ip: meta.ip },
    {
      action: "user.sessions_revoked",
      entityType: "user",
      entityId: auth.userId,
      summary: `Signed out ${signedOut} other session(s)`,
    },
  );
  return { ok: true as const, otherSessionsSignedOut: signedOut };
}

/**
 * "Forgot password?". The answer is the same whether or not the email has an
 * account, and the lookup and email happen after responding (`delivery`), so
 * neither the response nor its timing reveals which emails are registered.
 * `emailEnabled` is a server setting, not a property of the account.
 */
export async function requestPasswordReset(db: Database, input: { email: string }, meta: RequestMeta) {
  const email = normalizeEmail(input.email);
  await passwordResetLimiter.consume(`ip:${meta.ip ?? "unknown"}`, db);
  await passwordResetLimiter.consume(`email:${email}`, db);
  const mailer = getMailer();
  const delivery = mailer
    ? sendResetEmail(db, mailer, email, meta).catch((err: unknown) => {
        console.error("[auth] password reset email failed:", logSafeError(err));
      })
    : Promise.resolve();
  return { emailEnabled: mailer !== null, delivery };
}

async function sendResetEmail(db: Database, mailer: Mailer, email: string, meta: RequestMeta) {
  const [user] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(sql`lower(${users.email})`, email))
    .limit(1);
  if (!user) return;
  const link = await db.transaction(async (tx) => {
    const created = await createResetLink(tx, user.id);
    await audit(
      tx,
      { userId: user.id, orgId: null, ip: meta.ip },
      {
        action: "user.password_reset_requested",
        entityType: "user",
        entityId: user.id,
        summary: "Requested a password reset link",
      },
    );
    return created;
  });
  await mailer.send({
    to: user.email,
    subject: "Reset your FLOWOS password",
    text: [
      `Hello ${user.name},`,
      "",
      "Someone (hopefully you) asked to reset the password of your FLOWOS account.",
      "Open this link to choose a new password. It works once and expires in 1 hour:",
      "",
      link.url,
      "",
      "If you did not ask for this, ignore this email: your password stays the same.",
    ].join("\n"),
  });
}

/** Set a new password from a reset link. The link works once; every session is signed out. */
export async function resetPassword(
  db: Database,
  input: { token: string; password: string },
  meta: RequestMeta,
) {
  await loginLimiter.consume(`ip:${meta.ip ?? "unknown"}`, db);
  const passwordHash = await hashPassword(input.password);
  const tokenHash = hashToken(input.token);
  await db.transaction(async (tx) => {
    const [link] = await tx
      .select({ id: passwordResetTokens.id, userId: passwordResetTokens.userId })
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.tokenHash, tokenHash),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, new Date()),
        ),
      )
      .for("update");
    if (!link) {
      throw new AppError("BAD_REQUEST", "This reset link is invalid or has expired. Request a new one.");
    }
    await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(eq(passwordResetTokens.id, link.id));
    await tx.update(users).set({ passwordHash }).where(eq(users.id, link.userId));
    const signedOut = await revokeAllSessions(tx, link.userId);
    await audit(
      tx,
      { userId: link.userId, orgId: null, ip: meta.ip },
      {
        action: "user.password_reset",
        entityType: "user",
        entityId: link.userId,
        summary: `Reset password with an email link; signed out ${signedOut} session(s)`,
      },
    );
  });
  return { ok: true as const };
}

export async function listMyOrganizations(db: Database, userId: string) {
  return db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      taskPrefix: organizations.taskPrefix,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(eq(memberships.userId, userId))
    .orderBy(organizations.name);
}
