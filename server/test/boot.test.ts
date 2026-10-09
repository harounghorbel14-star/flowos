import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { ONBOARDING_TEMPLATE } from "@shared/workflows";
import { tasks } from "../src/db/schema";
import { addMember, createOrg, db } from "./helpers";

/**
 * Boots the server the way production does: one esbuild bundle (same flags as
 * `npm run build:server`) started with plain `node`, NODE_ENV=production.
 * Regression test for the bundle running the migration CLI at boot and then
 * closing its own pool, which left the workflow worker failing on every tick.
 */
const root = path.resolve(import.meta.dirname, "../..");
let child: ChildProcess | undefined;
let output = "";
let outDir: string | undefined;

async function freePort(): Promise<number> {
  const srv = createServer().listen(0);
  await once(srv, "listening");
  const { port } = srv.address() as { port: number };
  srv.close();
  return port;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${what}. Server output:\n${output}`);
}

afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe("production boot", () => {
  it("starts the bundled server without migrating and its worker runs workflows", async () => {
    // Inside the repo so the bundle's external imports resolve from node_modules.
    outDir = mkdtempSync(path.join(root, "node_modules", ".flowos-boot-"));
    const outfile = path.join(outDir, "index.js");
    await build({
      entryPoints: [path.join(root, "server/src/index.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      packages: "external",
      outfile,
      logLevel: "silent",
    });

    const port = await freePort();
    child = spawn(process.execPath, [outfile], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        DATABASE_URL: process.env.DATABASE_URL,
        APP_ORIGIN: `http://localhost:${port}`,
        PORT: String(port),
        STORAGE_DIR: process.env.STORAGE_DIR,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr!.on("data", (d: Buffer) => (output += d.toString()));

    await waitFor(
      async () => ((await fetch(`http://localhost:${port}/api/health`)).ok ? true : undefined),
      15_000,
      "health check",
    );

    // Set up through the services; only the spawned server's worker processes the events.
    const { owner, org, as } = await createOrg("Boot Check");
    const managerUser = await addMember(org.id, owner, "MANAGER", "Bo Manager");
    const manager = await as(owner).employees.create({
      firstName: "Bo",
      lastName: "Manager",
      email: `boot-${randomUUID()}@example.test`,
      userId: managerUser.id,
    });
    await as(owner).workflows.create({
      name: ONBOARDING_TEMPLATE.name,
      trigger: ONBOARDING_TEMPLATE.trigger,
      conditions: ONBOARDING_TEMPLATE.conditions,
      actions: ONBOARDING_TEMPLATE.actions,
    });
    await as(owner).employees.create({
      firstName: "Pia",
      lastName: "Prod",
      email: `boot-${randomUUID()}@example.test`,
      managerId: manager.id,
    });

    const taskActions = ONBOARDING_TEMPLATE.actions.filter((a) => a.type === "create_task").length;
    const created = await waitFor(
      async () => {
        const rows = await db()
          .select()
          .from(tasks)
          .where(and(eq(tasks.orgId, org.id), sql`${tasks.title} like '%Pia%'`));
        return rows.length >= taskActions ? rows : undefined;
      },
      20_000,
      "the workflow worker to create the onboarding tasks",
    );
    expect(created).toHaveLength(taskActions);

    expect(output).toContain("(production)");
    expect(output).not.toContain("Migrations applied");
    expect(output).not.toContain("worker tick failed");
  }, 60_000);
});
