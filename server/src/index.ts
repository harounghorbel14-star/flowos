import { createApp } from "./app";
import { runMigrations } from "./db/migrate";
import { env } from "./env";

async function main() {
  const config = env();
  if (process.env.FLOWOS_MIGRATE_ON_START !== "false") await runMigrations();
  const app = createApp();
  app.listen(config.PORT, () => {
    console.log(`FLOWOS API listening on :${config.PORT} (${config.NODE_ENV})`);
  });
}

main().catch((err: unknown) => {
  console.error("Failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
