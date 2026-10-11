import { createApp, markDraining } from "./app";
import { runMigrations } from "./db/migrate";
import { closeDb, getDb } from "./db/client";
import { pendingMigrations, schemaBehindMessage } from "./db/schema-status";
import { assertServerConfig, describeDatabase, env, readSwitch } from "./env";
import { logSafeError } from "./lib/logging";
import { startWorker } from "./modules/workflows/engine";

/** How long a shutdown may wait for in-flight requests and the worker tick. */
const SHUTDOWN_GRACE_MS = 10_000;

async function main() {
  const config = env();
  assertServerConfig();
  const database = describeDatabase();
  // Migrations are an explicit release step (npm run db:migrate). Hosts without one (e.g. Render
  // Free) opt in here; runMigrations locks, so overlapping starts apply each migration once.
  const migrateOnStart = readSwitch("FLOWOS_MIGRATE_ON_START");
  console.log(`Database: ${database}. Startup migrations: ${migrateOnStart.enabled ? "on" : "off"}.`);
  if (migrateOnStart.enabled) {
    const applied = await runMigrations();
    console.log(applied ? `Applied ${applied} migration(s) at startup.` : "Database schema is up to date.");
  }
  // Never serve or run the worker against an older schema: every query on a missing table
  // would fail (42P01). An unreachable database is not fatal here; /api/ready reports it.
  const pending = await pendingMigrations(getDb()).catch((err: unknown) => {
    console.warn("Could not verify the database schema at startup:", logSafeError(err));
    return null;
  });
  if (pending) {
    console.error(
      migrateOnStart.enabled
        ? `Migrations ran at startup but ${pending} are still pending in ${database}: its drizzle.__drizzle_migrations table does not match this version's drizzle/ folder. Refusing to start.`
        : `${schemaBehindMessage(pending, { database, migrateOnStart })} Refusing to start.`,
    );
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
  // logSafeError: a raw query error would print the statement's parameters.
  console.error("Failed to start:", err instanceof Error && !err.cause ? err.message : logSafeError(err));
  process.exit(1);
});
