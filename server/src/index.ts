import { createApp, markDraining } from "./app";
import { runMigrations } from "./db/migrate";
import { closeDb, getDb } from "./db/client";
import { pendingMigrations, schemaBehindMessage } from "./db/schema-status";
import { assertServerConfig, env } from "./env";
import { startWorker } from "./modules/workflows/engine";

/** How long a shutdown may wait for in-flight requests and the worker tick. */
const SHUTDOWN_GRACE_MS = 10_000;

async function main() {
  const config = env();
  assertServerConfig();
  // Migrations are an explicit step (npm run db:migrate). Opt in for single-instance setups.
  if (process.env.FLOWOS_MIGRATE_ON_START === "true") await runMigrations();
  // Never serve or run the worker against an older schema: every query on a missing table
  // would fail (42P01). An unreachable database is not fatal here; /api/ready reports it.
  const pending = await pendingMigrations(getDb()).catch(() => null);
  if (pending) {
    console.error(`${schemaBehindMessage(pending)} Refusing to start.`);
    await closeDb();
    process.exit(1);
  }
  const app = createApp();
  // Workflow worker runs in-process; set FLOWOS_WORKER=false to run API-only replicas.
  const stopWorker = process.env.FLOWOS_WORKER !== "false" ? startWorker(getDb()) : async () => {};
  const server = app.listen(config.PORT, () => {
    console.log(`FLOWOS API listening on :${config.PORT} (${config.NODE_ENV})`);
  });
  // e.g. port already in use: exit non-zero so the supervisor notices.
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`Failed to start HTTP server: ${err.code ?? err.message}`);
    process.exit(1);
  });
  // Outlive typical load-balancer idle timeouts (60 s) to avoid sporadic 502s on reused connections.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  if (config.NODE_ENV === "production" && config.TRUST_PROXY === 0) {
    console.warn(
      "TRUST_PROXY=0: client IPs are taken from the socket. Behind a load balancer, set TRUST_PROXY to the number of proxy hops, otherwise all clients share one rate-limit bucket.",
    );
  }

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received: shutting down`);
    markDraining();
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
