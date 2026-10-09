import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/** Recreate the test schema from scratch and apply the real migrations. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://flowos:flowos@localhost:5432/flowos_test";
  if (!/test/.test(new URL(url).pathname))
    throw new Error("Refusing to reset a database whose name lacks 'test'.");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(
    "drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;",
  );
  await migrate(drizzle(client), { migrationsFolder: path.resolve(import.meta.dirname, "../../drizzle") });
  await client.end();
}
