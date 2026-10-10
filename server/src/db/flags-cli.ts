// Operator CLI for per-organization feature flags (not exposed to organization members).
//   npm run flags -- list <orgId>
//   npm run flags -- set <orgId> <feature> on|off [reason…]
//   npm run flags -- clear <orgId> <feature>
import { and, eq } from "drizzle-orm";
import { FEATURES, type Feature } from "@shared/billing";
import { closeDb, getDb } from "./client";
import { featureFlags, organizations } from "./schema";

async function main(args: string[]) {
  const [command, orgId, feature, value, ...reason] = args;
  const db = getDb();
  if (!command || !orgId || !["list", "set", "clear"].includes(command)) {
    throw new Error(
      "Usage: flags list <orgId> | set <orgId> <feature> on|off [reason] | clear <orgId> <feature>",
    );
  }
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!org) throw new Error("No organization with that id.");
  if (command === "list") {
    const rows = await db.select().from(featureFlags).where(eq(featureFlags.orgId, orgId));
    for (const r of rows) console.log(`${r.feature}\t${r.enabled ? "on" : "off"}\t${r.reason ?? ""}`);
    if (rows.length === 0) console.log("No overrides; the plan decides.");
    return;
  }
  if (!feature || !(FEATURES as readonly string[]).includes(feature)) {
    throw new Error(`Unknown feature. Known: ${FEATURES.join(", ")}`);
  }
  if (command === "clear") {
    await db
      .delete(featureFlags)
      .where(and(eq(featureFlags.orgId, orgId), eq(featureFlags.feature, feature)));
    console.log(`Cleared ${feature}; the plan decides.`);
    return;
  }
  if (value !== "on" && value !== "off") throw new Error("Value must be on or off.");
  const row = {
    orgId,
    feature: feature as Feature,
    enabled: value === "on",
    reason: reason.join(" ") || null,
    updatedAt: new Date(),
  };
  await db
    .insert(featureFlags)
    .values(row)
    .onConflictDoUpdate({ target: [featureFlags.orgId, featureFlags.feature], set: row });
  console.log(`${feature} is now ${value} for ${orgId}.`);
}

main(process.argv.slice(2))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
