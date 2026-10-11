import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb } from "./client";
import { MIGRATIONS_FOLDER } from "./schema-status";

export async function runMigrations(): Promise<void> {
  await migrate(getDb(), { migrationsFolder: MIGRATIONS_FOLDER });
}
