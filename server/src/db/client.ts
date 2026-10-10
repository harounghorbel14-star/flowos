import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../env";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
/** Either the root database handle or an open transaction. */
export type Tx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

let pool: pg.Pool | undefined;
let database: Database | undefined;

export function getDb(): Database {
  if (!database) {
    pool = new pg.Pool({
      connectionString: env().DATABASE_URL,
      max: 10,
      // Fail fast instead of hanging when the database is unreachable.
      connectionTimeoutMillis: 5000,
      // Date math (current_date, overdue checks) is defined in UTC everywhere. Bound runaway
      // statements and transactions left open by a stuck request.
      options: "-c timezone=UTC -c statement_timeout=30s -c idle_in_transaction_session_timeout=60s",
    });
    // An idle client losing its connection (database restart, failover) must not crash the
    // process; the pool replaces it on the next checkout.
    pool.on("error", (err) => {
      console.warn("[db] idle connection lost:", (err as { code?: string }).code ?? err.message);
    });
    database = drizzle(pool, { schema });
  }
  return database;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  database = undefined;
}
