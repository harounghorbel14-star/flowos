import { eq, sql } from "drizzle-orm";
import { getDummyHash, hashPassword, verifyPassword } from "../../auth/password";
import { loginLimiter, signupLimiter } from "../../auth/rateLimit";
import { createSession, revokeSession } from "../../auth/session";
import type { Database } from "../../db/client";
import { memberships, organizations, users } from "../../db/schema";
import { audit } from "../../lib/audit";
import { AppError, conflict } from "../../lib/errors";

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
  signupLimiter.consume(`ip:${meta.ip ?? "unknown"}`);
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
  loginLimiter.consume(`ip:${meta.ip ?? "unknown"}`);
  loginLimiter.consume(`email:${email}`);
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

export async function listMyOrganizations(db: Database, userId: string) {
  return db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(eq(memberships.userId, userId))
    .orderBy(organizations.name);
}
