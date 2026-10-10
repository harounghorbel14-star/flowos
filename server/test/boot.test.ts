import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
let outfile = "";

const childEnv = (port: number): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  NODE_ENV: "production",
  DATABASE_URL: process.env.DATABASE_URL,
  APP_ORIGIN: `http://localhost:${port}`,
  PORT: String(port),
  STORAGE_DIR: process.env.STORAGE_DIR,
});

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

beforeAll(async () => {
  // Inside the repo so the bundle's external imports resolve from node_modules.
  outDir = mkdtempSync(path.join(root, "node_modules", ".flowos-boot-"));
  outfile = path.join(outDir, "index.js");
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
});

afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe("production boot", () => {
  it("starts the bundled server without migrating and its worker runs workflows", async () => {
    const port = await freePort();
    child = spawn(process.execPath, [outfile], {
      cwd: root,
      env: childEnv(port),
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

    // Readiness reflects the database.
    const ready = await fetch(`http://localhost:${port}/api/ready`);
    expect(ready.status).toBe(200);

    // A database restart drops idle connections: the server must survive and reconnect.
    await db().execute(sql`
      select pg_terminate_backend(pid) from pg_stat_activity
       where datname = current_database() and pid <> pg_backend_pid() and state = 'idle'`);
    await new Promise((r) => setTimeout(r, 500));
    expect(child.exitCode).toBeNull();
    await waitFor(
      async () => ((await fetch(`http://localhost:${port}/api/ready`)).ok ? true : undefined),
      10_000,
      "readiness after the database dropped connections",
    );

    // A second instance on the same port must fail loudly, not exit 0.
    const clash = spawn(process.execPath, [outfile], {
      cwd: root,
      env: { ...childEnv(port), FLOWOS_WORKER: "false" },
      stdio: "ignore",
    });
    const [clashCode] = (await once(clash, "exit")) as [number | null];
    expect(clashCode).toBe(1);

    // SIGTERM: finish in-flight work, close the pool, exit 0.
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const [code] = (await exited) as [number | null];
    expect(code).toBe(0);
    expect(output).toContain("Shutdown complete.");
  }, 60_000);

  it("reports not ready, but stays alive, when the database is unreachable", async () => {
    const port = await freePort();
    const proc = spawn(process.execPath, [outfile], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
        APP_ORIGIN: `http://localhost:${port}`,
        PORT: String(port),
        FLOWOS_WORKER: "false",
      },
      stdio: "ignore",
    });
    try {
      await waitFor(
        async () => ((await fetch(`http://localhost:${port}/api/health`)).ok ? true : undefined),
        15_000,
        "health check",
      );
      const ready = await fetch(`http://localhost:${port}/api/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ ok: false, error: "database unavailable" });
    } finally {
      proc.kill("SIGTERM");
      await once(proc, "exit");
    }
  }, 60_000);

  it("refuses to start in production without APP_ORIGIN, naming only the variable", async () => {
    const port = await freePort();
    const env: NodeJS.ProcessEnv = { ...childEnv(port), FLOWOS_WORKER: "false" };
    delete env.APP_ORIGIN;
    const proc = spawn(process.execPath, [outfile], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    proc.stderr!.on("data", (d: Buffer) => (err += d.toString()));
    const [code] = (await once(proc, "exit")) as [number | null];
    expect(code).toBe(1);
    expect(err).toContain("Missing required production configuration: APP_ORIGIN");
    expect(err).not.toContain("postgres://");
  }, 30_000);

  it("the migration tool runs in production without the web server's settings", async () => {
    const migrateFile = path.join(outDir!, "migrate.js");
    await build({
      entryPoints: [path.join(root, "server/src/db/migrate-cli.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      packages: "external",
      outfile: migrateFile,
      logLevel: "silent",
    });
    const proc = spawn(process.execPath, [migrateFile], {
      cwd: root,
      env: { PATH: process.env.PATH, NODE_ENV: "production", DATABASE_URL: process.env.DATABASE_URL },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    proc.stderr!.on("data", (d: Buffer) => (out += d.toString()));
    const [code] = (await once(proc, "exit")) as [number | null];
    expect(out).toContain("Migrations applied.");
    expect(code).toBe(0);
  }, 30_000);
});
