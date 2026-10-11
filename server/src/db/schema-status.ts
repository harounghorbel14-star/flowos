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

/**
 * Why the server refuses to start, and how to fix it. `migrateOnStart.raw` is what this process
 * actually received for FLOWOS_MIGRATE_ON_START (a switch, not a secret).
 */
export function schemaBehindMessage(
  pending: number,
  context: { database?: string; migrateOnStart?: { enabled: boolean; raw: string | undefined } } = {},
): string {
  const where = context.database ? ` in ${context.database}` : "";
  const sw = context.migrateOnStart;
  const switchState = !sw
    ? ""
    : sw.enabled
      ? ""
      : sw.raw === undefined
        ? "FLOWOS_MIGRATE_ON_START is not set in this process (if you set it on your host, check the exact name, that it belongs to this service, and redeploy so the running service receives it). "
        : `FLOWOS_MIGRATE_ON_START is ${JSON.stringify(sw.raw)}, which means off. `;
  return (
    `Database schema is behind this version: ${pending} migration(s) not applied${where}. ${switchState}` +
    "Apply them first: `node dist/server/migrate.js` as the release / pre-deploy step " +
    "(`npm run db:migrate` in development), or set FLOWOS_MIGRATE_ON_START=true when the host has no release step."
  );
}
