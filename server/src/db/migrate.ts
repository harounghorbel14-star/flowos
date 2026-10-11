import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { env } from "../env";
import { logSafeError } from "../lib/logging";
import { MIGRATIONS_FOLDER, pendingMigrations } from "./schema-status";

/** Arbitrary, FLOWOS-specific key for pg_advisory_lock: one migrator at a time per database. */
const MIGRATION_LOCK_KEY = 7_315_220_461;

/**
 * Apply this version's pending migrations to DATABASE_URL and return how many ran.
 *
 * - Holds a session advisory lock, so concurrent starters (an overlapping deploy, a
 *   restart, the CLI and a server) run one after another: the first applies, the rest
 *   find nothing pending. Drizzle alone reads the last applied migration outside its
 *   transaction, so two at once would both try and one would fail.
 * - All pending migrations run in one transaction: on error nothing is applied.
 * - Uses its own connection without the app pool's 30 s statement timeout, so a slow
 *   migration is not cancelled halfway.
 * Errors never include query parameters or the connection string.
 */
export async function runMigrations(): Promise<number> {
  const client = new pg.Client({ connectionString: env().DATABASE_URL, connectionTimeoutMillis: 10_000 });
  // An error on an idle client must not crash the process; the query in flight rejects anyway.
  client.on("error", () => {});
  await client.connect();
  let pending = 0;
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    const db = drizzle(client);
    pending = await pendingMigrations(db);
    if (pending > 0) await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return pending;
  } catch (err) {
    throw new Error(
      `Applying ${pending} pending migration(s) failed and was rolled back; the database is unchanged. ${logSafeError(err)}`,
    );
  } finally {
    // Ending the session also releases the advisory lock.
    await client.end().catch(() => {});
  }
}
