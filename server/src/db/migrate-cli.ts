// CLI entry for `npm run db:migrate`. Kept apart from migrate.ts: the server bundle imports
// runMigrations, and an "is this the main module?" check there is true inside the bundle,
// which made the production server migrate at boot and then close its own pool.
import { closeDb } from "./client";
import { runMigrations } from "./migrate";

runMigrations()
  .then((applied) => console.log(`Migrations applied. ${applied ? `${applied} new.` : "None were pending."}`))
  .catch((err: unknown) => {
    console.error("Migration failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
