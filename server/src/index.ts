import { createApp } from "./app";
import { runMigrations } from "./db/migrate";
import { closeDb, getDb } from "./db/client";
import { env } from "./env";
import { startWorker } from "./modules/workflows/engine";

/** How long a shutdown may wait for in-flight requests and the worker tick. */
const SHUTDOWN_GRACE_MS = 10_000;

async function main() {
  const config = env();
  // Migrations are an explicit step (npm run db:migrate). Opt in for single-instance setups.
  if (process.env.FLOWOS_MIGRATE_ON_START === "true") await runMigrations();
  const app = createApp();
  // Workflow worker runs in-process; set FLOWOS_WORKER=false to run API-only replicas.
  const stopWorker = process.env.FLOWOS_WORKER !== "false" ? startWorker(getDb()) : async () => {};
  const server = app.listen(config.PORT, () => {
    console.log(`FLOWOS API listening on :${config.PORT} (${config.NODE_ENV})`);
  });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received: shutting down`);
    const force = setTimeout(() => {
      console.error("Shutdown timed out; exiting.");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    // Stop accepting connections, let in-flight requests and the worker tick finish, then close the pool.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    Promise.all([closed, stopWorker()])
      .then(() => closeDb())
      .then(() => {
        console.log("Shutdown complete.");
        process.exit(0);
      })
      .catch((err: unknown) => {
        console.error("Shutdown failed:", err instanceof Error ? err.message : err);
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error("Failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
