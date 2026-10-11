// Operator CLI: a password reset link for a user, when outgoing email is not configured.
//   npm run reset-link -- <email>          (development)
//   node dist/server/reset-link.js <email> (production image)
// Prints the link to this terminal only; hand it to that person privately. It works once
// and expires in 1 hour. Requesting another link (here or by email) cancels this one.
import { eq, sql } from "drizzle-orm";
import { createResetLink } from "../auth/passwordReset";
import { audit } from "../lib/audit";
import { closeDb, getDb } from "./client";
import { users } from "./schema";

async function main(email: string | undefined) {
  if (!email) throw new Error("Usage: reset-link <email>");
  const db = getDb();
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(sql`lower(${users.email})`, email.trim().toLowerCase()));
  if (!user) throw new Error("No account with that email.");
  const link = await db.transaction(async (tx) => {
    const created = await createResetLink(tx, user.id);
    await audit(
      tx,
      { userId: null, orgId: null, ip: null },
      {
        action: "user.password_reset_link_created",
        entityType: "user",
        entityId: user.id,
        summary: "Operator created a password reset link",
      },
    );
    return created;
  });
  console.log(`Password reset link for ${user.email} (single use, expires ${link.expiresAt.toISOString()}):`);
  console.log(link.url);
}

main(process.argv[2])
  .catch((err: unknown) => {
    console.error("reset-link failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
