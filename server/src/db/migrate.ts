import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, getDb } from "./client";

export async function runMigrations(): Promise<void> {
  await migrate(getDb(), { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  runMigrations()
    .then(() => console.log("Migrations applied."))
    .catch((err: unknown) => {
      console.error("Migration failed:", err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
