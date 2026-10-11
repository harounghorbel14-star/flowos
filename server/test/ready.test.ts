import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../src/db/client";
import { createScratchDatabase } from "./helpers";

/**
 * /api/ready must not report ready on a database without this version's
 * migrations: a platform health check would otherwise put a server whose every
 * query fails (42P01) into service. This file's own database is a scratch one.
 */
let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
let server: Server;
let base = "";

beforeAll(async () => {
  scratch = await createScratchDatabase("ready");
  process.env.DATABASE_URL = scratch.url; // before anything opens the pool
  const { createApp } = await import("../src/app");
  server = createApp().listen(0);
  base = `http://localhost:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((r) => server?.close(r));
  await closeDb();
  await scratch?.drop();
});

describe("readiness and the database schema", () => {
  it("is 503 until the migrations are applied, then 200", async () => {
    const before = await fetch(`${base}/api/ready`);
    expect(before.status).toBe(503);
    expect(await before.json()).toEqual({ ok: false, error: "database schema not migrated" });

    const { runMigrations } = await import("../src/db/migrate");
    await runMigrations();

    const after = await fetch(`${base}/api/ready`);
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ ok: true });
  });
});
