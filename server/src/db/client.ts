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
      // Date math (current_date, overdue checks) is defined in UTC everywhere.
      options: "-c timezone=UTC",
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
