import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Role } from "@shared/domain";
import type { Database } from "../db/client";
import { memberships } from "../db/schema";
import type { Actor } from "./actor";

const uuid = z.string().uuid();

/**
 * Build the verified Actor for a user acting in an organization, or null if
 * the organization id is malformed or the user is not a member. This is the
 * single place tenant context is established, for tRPC and plain routes alike.
 */
export async function loadActor(
  db: Database,
  userId: string,
  orgId: string | null | undefined,
  ip: string | null,
) {
  if (!orgId || !uuid.safeParse(orgId).success) return { actor: null, reason: "NO_ORG" as const };
  const [membership] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
    .limit(1);
  if (!membership) return { actor: null, reason: "NOT_MEMBER" as const };
  const actor: Actor = { userId, orgId, role: membership.role as Role, ip };
  return { actor, reason: null };
}
