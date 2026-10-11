import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getTableName, isTable, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema";
import { MIGRATIONS_FOLDER, pendingMigrations } from "../src/db/schema-status";
import { createScratchDatabase, db } from "./helpers";

/**
 * Regression for a deployment whose migrations never ran (or stopped at an
 * older version): the server started, /api/ready said ok, and every worker
 * tick failed with 42P01 (undefined table).
 */
const tables = Object.values(schema)
  .filter((v) => isTable(v))
  .map((t) => getTableName(t as never));
const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ tag: string }>;
};

/** A copy of the migrations folder holding only the first `count` migrations. */
function olderMigrations(count: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "flowos-migrations-"));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  writeFileSync(
    path.join(dir, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, count) }),
  );
  return dir;
}

describe("database schema and migrations", () => {
  it("every table the code uses is created by the migrations", async () => {
    const rows = (
      await db().execute<{ name: string }>(sql`
        select table_name as name from information_schema.tables where table_schema = 'public'`)
    ).rows.map((r) => r.name);
    expect(tables.length).toBeGreaterThan(30);
    expect(tables.filter((t) => !rows.includes(t))).toEqual([]);
  });

  it("a migrated database has no pending migrations", async () => {
    expect(await pendingMigrations(db())).toBe(0);
  });

  describe("an unmigrated database", () => {
    let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
    let pool: pg.Pool;
    let older: string;
    beforeAll(async () => {
      scratch = await createScratchDatabase("pending");
      pool = new pg.Pool({ connectionString: scratch.url });
      older = olderMigrations(9); // what `main` shipped before billing and integrations
    });
    afterAll(async () => {
      await pool?.end();
      await scratch?.drop();
      if (older) rmSync(older, { recursive: true, force: true });
    });

    it("counts every migration as pending when none ran", async () => {
      expect(await pendingMigrations(drizzle(pool))).toBe(journal.entries.length);
    });

    it("counts the missing ones after an older release, and upgrading keeps the data", async () => {
      const scratchDb = drizzle(pool);
      await migrate(scratchDb, { migrationsFolder: older });
      expect(await pendingMigrations(scratchDb)).toBe(journal.entries.length - 9);

      await pool.query(
        `insert into users (email, name, password_hash) values ('kept@example.test', 'Kept', 'x')`,
      );
      await pool.query(`insert into organizations (name, slug) values ('Kept Org', 'kept-org')`);

      await migrate(scratchDb, { migrationsFolder: MIGRATIONS_FOLDER });
      expect(await pendingMigrations(scratchDb)).toBe(0);
      const kept = await pool.query(
        `select (select count(*) from users where email = 'kept@example.test')::int as users,
                (select count(*) from organizations where slug = 'kept-org')::int as orgs`,
      );
      expect(kept.rows[0]).toEqual({ users: 1, orgs: 1 });
      // The tables the worker needed (e.g. webhook_events, metric_snapshots) now exist.
      const { rows } = await pool.query<{ name: string }>(
        "select table_name as name from information_schema.tables where table_schema = 'public'",
      );
      expect(tables.filter((t) => !rows.map((r) => r.name).includes(t))).toEqual([]);
    });
  });
});
