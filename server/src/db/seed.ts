/**
 * Demo data for local testing and staging demos: `npm run db:seed`.
 *
 * Creates two organizations and six users through the regular API procedures
 * (same validation, permissions, audit log and workflow events as the UI).
 * Refuses to run when NODE_ENV=production unless FLOWOS_ALLOW_DEMO_SEED=true and a
 * private FLOWOS_DEMO_PASSWORD (16+ characters) is set; see seed-guard.ts.
 * and does nothing if the demo owner already exists. Never run it against a
 * database with real customers.
 */
import { eq, sql } from "drizzle-orm";
import { ONBOARDING_TEMPLATE } from "@shared/workflows";
import { hashPassword } from "../auth/password";
import type { Context } from "../trpc/context";
import { createCaller } from "../trpc/router";
import { closeDb, getDb } from "./client";
import { users } from "./schema";
import { demoSeedPassword } from "./seed-guard";

const DOMAIN = "demo.flowos.test";

const PEOPLE = {
  owner: { name: "Olivia Owner", email: `owner@${DOMAIN}` },
  admin: { name: "Adam Admin", email: `admin@${DOMAIN}` },
  manager: { name: "Maya Manager", email: `manager@${DOMAIN}` },
  member: { name: "Milo Member", email: `member@${DOMAIN}` },
  viewer: { name: "Vera Viewer", email: `viewer@${DOMAIN}` },
  outsider: { name: "Oscar Outsider", email: `outsider@${DOMAIN}` },
} as const;
type Key = keyof typeof PEOPLE;
type SeedUser = { id: string; email: string; name: string };

const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

function caller(user: SeedUser | null, orgId?: string) {
  const ctx: Context = {
    db: getDb(),
    ip: "127.0.0.1",
    userAgent: "flowos-seed",
    requestedOrgId: orgId ?? null,
    auth: user ? { sessionId: "seed", expiresAt: new Date(Date.now() + 3_600_000), user } : null,
    setSessionCookie: () => {},
    clearSessionCookie: () => {},
  };
  return createCaller(ctx);
}

async function main() {
  // Throws unless seeding is allowed here; never yields a predictable password in production.
  const { password, documented } = demoSeedPassword(process.env);
  const db = getDb();
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, PEOPLE.owner.email));
  if (existing) {
    console.log("Demo data already present; nothing to do.");
    return;
  }

  // Users are inserted directly (signup is rate limited per IP); everything else goes through the API.
  const passwordHash = await hashPassword(password);
  const u = {} as Record<Key, SeedUser>;
  for (const [key, p] of Object.entries(PEOPLE) as Array<[Key, (typeof PEOPLE)[Key]]>) {
    const [row] = await db
      .insert(users)
      .values({ email: p.email, name: p.name, passwordHash })
      .returning({ id: users.id, email: users.email, name: users.name });
    u[key] = row!;
  }

  // Organization A: Northwind Demo, with every role.
  const org = await caller(u.owner).orgs.create({
    name: "Northwind Demo",
    addMeAsEmployee: true,
    jobTitle: "Managing Director",
  });
  const asOwner = caller(u.owner, org.id);
  for (const [key, role] of [
    ["admin", "ADMIN"],
    ["manager", "MANAGER"],
    ["member", "MEMBER"],
    ["viewer", "VIEWER"],
  ] as const) {
    const invite = await asOwner.orgs.invite({ email: u[key].email, role });
    await caller(u[key]).orgs.acceptInvitation({ token: invite.token });
  }

  const ops = await asOwner.departments.create({
    name: "Operations",
    description: "Facilities, IT and people operations",
  });
  const eng = await asOwner.departments.create({ name: "Engineering", description: "Product and platform" });
  const sales = await asOwner.departments.create({ name: "Sales" });

  const maya = await asOwner.employees.create({
    firstName: "Maya",
    lastName: "Manager",
    email: u.manager.email,
    userId: u.manager.id,
    jobTitle: "Head of Operations",
    departmentId: ops.id,
    startDate: isoDay(-400),
  });
  const milo = await asOwner.employees.create({
    firstName: "Milo",
    lastName: "Member",
    email: u.member.email,
    userId: u.member.id,
    jobTitle: "Software Engineer",
    departmentId: eng.id,
    managerId: maya.id,
    startDate: isoDay(-120),
  });
  const ravi = await asOwner.employees.create({
    firstName: "Ravi",
    lastName: "Sharma",
    email: `ravi@${DOMAIN}`,
    jobTitle: "Account Executive",
    departmentId: sales.id,
    managerId: maya.id,
    startDate: isoDay(-30),
  });

  const site = await asOwner.projects.create({
    name: "Website relaunch",
    description: "New marketing site and customer portal.",
    ownerEmployeeId: maya.id,
    startDate: isoDay(-21),
    dueDate: isoDay(14),
    memberIds: [maya.id, milo.id],
  });
  await asOwner.projects.create({ name: "Q4 hiring plan", ownerEmployeeId: maya.id, dueDate: isoDay(40) });

  const tasks = [
    {
      title: "Draft sitemap",
      projectId: site.id,
      assigneeEmployeeId: milo.id,
      priority: "HIGH",
      dueDate: isoDay(-2),
    },
    {
      title: "Choose hosting provider",
      projectId: site.id,
      assigneeEmployeeId: maya.id,
      status: "BLOCKED",
      dueDate: isoDay(3),
    },
    {
      title: "Write launch announcement",
      projectId: site.id,
      assigneeEmployeeId: ravi.id,
      status: "IN_PROGRESS",
      dueDate: isoDay(7),
    },
    {
      title: "Order laptops for new hires",
      assigneeEmployeeId: maya.id,
      priority: "URGENT",
      dueDate: isoDay(1),
    },
    { title: "Update the employee handbook", status: "TODO" },
  ] as const;
  for (const t of tasks) await asOwner.tasks.create(t);
  const done = await asOwner.tasks.create({
    title: "Set up project board",
    projectId: site.id,
    assigneeEmployeeId: milo.id,
  });
  await asOwner.tasks.update({ id: done.id, status: "DONE" });

  // Approvals: one pending for the manager, one already decided.
  const asMember = caller(u.member, org.id);
  await asMember.approvals.create({
    type: "LEAVE",
    title: "Summer holiday",
    approverUserId: u.manager.id,
    payload: { leaveType: "ANNUAL", startDate: isoDay(30), endDate: isoDay(39) },
  });
  const purchase = await asMember.approvals.create({
    type: "PURCHASE",
    title: "Second monitor",
    description: "27-inch monitor for the design reviews.",
    approverUserId: u.manager.id,
    payload: { amount: 240, currency: "EUR", vendor: "Office Supplies Co" },
  });
  await caller(u.manager, org.id).approvals.decide({
    id: purchase.id,
    decision: "APPROVED",
    comment: "Approved, thanks.",
  });

  // The onboarding workflow (runs when an active employee is added).
  await asOwner.workflows.create({
    name: ONBOARDING_TEMPLATE.name,
    description: ONBOARDING_TEMPLATE.description,
    trigger: ONBOARDING_TEMPLATE.trigger,
    conditions: ONBOARDING_TEMPLATE.conditions,
    actions: ONBOARDING_TEMPLATE.actions,
  });

  // Organization B: a separate tenant for isolation checks.
  const other = await caller(u.outsider).orgs.create({ name: "Other Company Ltd", addMeAsEmployee: true });
  await caller(u.outsider, other.id).tasks.create({ title: "Confidential: Other Company merger plan" });

  const [{ n }] = (await db.execute<{ n: number }>(sql`select count(*)::int as n from users`)).rows as [
    { n: number },
  ];
  console.log(`Demo data created (${n} users in the database).`);
  console.log(`Organizations: "Northwind Demo" (all roles) and "Other Company Ltd" (outsider only).`);
  console.log(
    `Sign in with any of: ${Object.values(PEOPLE)
      .map((p) => p.email)
      .join(", ")}`,
  );
  // The password is printed only when it is the documented local one; a chosen password is never echoed.
  console.log(
    documented
      ? `Password for all demo users: ${password} (local demo only).`
      : "Password: the value you set in FLOWOS_DEMO_PASSWORD.",
  );
}

main()
  .catch((err: unknown) => {
    console.error("Seed failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
