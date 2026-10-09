import { createApp } from "./app";
import { runMigrations } from "./db/migrate";
import { getDb } from "./db/client";
import { env } from "./env";
import { startWorker } from "./modules/workflows/engine";

async function main() {
  const config = env();
  // Migrations are an explicit step (npm run db:migrate). Opt in for single-instance setups.
  if (process.env.FLOWOS_MIGRATE_ON_START === "true") await runMigrations();
  const app = createApp();
  // Workflow worker runs in-process; set FLOWOS_WORKER=false to run API-only replicas.
  if (process.env.FLOWOS_WORKER !== "false") startWorker(getDb());
  app.listen(config.PORT, () => {
    console.log(`FLOWOS API listening on :${config.PORT} (${config.NODE_ENV})`);
  });
}

main().catch((err: unknown) => {
  console.error("Failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
