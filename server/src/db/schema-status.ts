import path from "node:path";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { Database } from "./client";

/** The bundle, the CLI and the image all run from the project root, next to `drizzle/`. */
export const MIGRATIONS_FOLDER = path.resolve(process.cwd(), "drizzle");

/**
 * How many of this version's migrations the database has not applied, by the
 * same rule drizzle's migrator uses (a migration is applied when its folder
 * timestamp is not newer than the last recorded one). A database that has
 * never been migrated counts every migration. Read-only.
 */
export async function pendingMigrations(
  db: Pick<Database, "execute">,
  migrationsFolder = MIGRATIONS_FOLDER,
): Promise<number> {
  const expected = readMigrationFiles({ migrationsFolder });
  const [{ present }] = (
    await db.execute<{ present: boolean }>(
      sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`,
    )
  ).rows as [{ present: boolean }];
  if (!present) return expected.length;
  const [{ last }] = (
    await db.execute<{ last: string | null }>(
      sql`select max(created_at)::text as last from drizzle.__drizzle_migrations`,
    )
  ).rows as [{ last: string | null }];
  if (last === null) return expected.length;
  return expected.filter((m) => m.folderMillis > Number(last)).length;
}

export function schemaBehindMessage(pending: number): string {
  return (
    `Database schema is behind this version: ${pending} migration(s) not applied. ` +
    "Apply them first: `node dist/server/migrate.js` as the release / pre-deploy step " +
    "(`npm run db:migrate` in development), or set FLOWOS_MIGRATE_ON_START=true on a single instance."
  );
}
