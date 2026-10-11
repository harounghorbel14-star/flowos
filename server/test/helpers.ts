import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll } from "vitest";
import { loginLimiter, signupLimiter } from "../src/auth/rateLimit";
import { closeDb, getDb } from "../src/db/client";
import type { Context } from "../src/trpc/context";
import { createCaller } from "../src/trpc/router";

export const db = () => getDb();

afterAll(async () => {
  await closeDb();
});

export interface TestUser {
  id: string;
  email: string;
  name: string;
}

function baseContext(overrides: Partial<Context> = {}): Context {
  return {
    db: getDb(),
    ip: "127.0.0.1",
    userAgent: "vitest",
    requestedOrgId: null,
    auth: null,
    setSessionCookie: () => {},
    clearSessionCookie: () => {},
    ...overrides,
  };
}

export function anonCaller(overrides: Partial<Context> = {}) {
  return createCaller(baseContext(overrides));
}

/** Caller acting as `user`, optionally inside `orgId`. Membership is still verified server-side. */
export function callerFor(user: TestUser, orgId?: string) {
  return createCaller(
    baseContext({
      requestedOrgId: orgId ?? null,
      auth: { sessionId: "test", expiresAt: new Date(Date.now() + 3600_000), user },
    }),
  );
}

export async function createUser(name = "Test User"): Promise<TestUser> {
  await signupLimiter.reset();
  const email = `u-${randomUUID()}@example.test`;
  const { user } = await anonCaller({ ip: randomUUID() }).auth.signup({
    email,
    name,
    password: "correct-horse-42",
  });
  return user;
}

/** Create an organization owned by a fresh user. */
export async function createOrg(name = "Acme Ops") {
  const owner = await createUser("Olivia Owner");
  const org = await callerFor(owner).orgs.create({ name, addMeAsEmployee: true });
  return { owner, org, as: (u: TestUser) => callerFor(u, org.id) };
}

/** Add a user to an org with a role via the real invitation flow. */
export async function addMember(
  orgId: string,
  owner: TestUser,
  role: "ADMIN" | "MANAGER" | "MEMBER" | "VIEWER",
  name = `${role.toLowerCase()} user`,
) {
  const user = await createUser(name);
  const invite = await callerFor(owner, orgId).orgs.invite({ email: user.email, role });
  await callerFor(user).orgs.acceptInvitation({ token: invite.token });
  return user;
}

export async function resetLimiters() {
  await loginLimiter.reset();
  await signupLimiter.reset();
}

/**
 * A fresh, empty database next to the test database (its name contains "test").
 * Needs CREATEDB; used to reproduce a deployment whose migrations never ran.
 */
export async function createScratchDatabase(suffix: string) {
  const base = new URL(process.env.DATABASE_URL!);
  const name = `${base.pathname.slice(1)}_${suffix}`;
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  await admin.query(`drop database if exists "${name}"`);
  await admin.query(`create database "${name}"`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      const c = new pg.Client({ connectionString: base.toString() });
      await c.connect();
      await c.query(`drop database if exists "${name}" with (force)`);
      await c.end();
    },
  };
}
