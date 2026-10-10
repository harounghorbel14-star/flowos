import { and, count, eq, gte, isNull, gt, sql, sum } from "drizzle-orm";
import {
  ENTITLED_STATUSES,
  FEATURE_LABELS,
  FEATURES,
  PLANS,
  type EffectivePlanId,
  type Feature,
  type Limits,
} from "@shared/billing";
import type { Tx } from "../../db/client";
import {
  aiUsage,
  documents,
  featureFlags,
  organizations,
  invitations,
  memberships,
  subscriptions,
  workflows,
} from "../../db/schema";
import { AppError } from "../../lib/errors";
import { billingConfig } from "./gateway";

export interface Entitlements {
  billingEnabled: boolean;
  plan: EffectivePlanId;
  limits: Limits;
  features: Feature[];
  subscription: {
    status: string;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
  } | null;
}

/**
 * What an organization may use right now. Without billing configured the
 * server is self-hosted: no limits and every feature. Otherwise the plan comes
 * from the subscription (Free when there is none or it is not in good
 * standing), and operator feature flags override plan features either way.
 */
export async function getEntitlements(db: Tx, orgId: string): Promise<Entitlements> {
  const billingEnabled = billingConfig() !== null;
  const [sub] = billingEnabled
    ? await db.select().from(subscriptions).where(eq(subscriptions.orgId, orgId))
    : [];
  const entitled = sub && (ENTITLED_STATUSES as readonly string[]).includes(sub.status);
  const plan: EffectivePlanId = !billingEnabled ? "SELF_HOSTED" : entitled ? sub.plan : "FREE";

  const features = new Set<Feature>(PLANS[plan].features);
  const flags = await db.select().from(featureFlags).where(eq(featureFlags.orgId, orgId));
  for (const f of flags) {
    if (!(FEATURES as readonly string[]).includes(f.feature)) continue;
    if (f.enabled) features.add(f.feature as Feature);
    else features.delete(f.feature as Feature);
  }
  return {
    billingEnabled,
    plan,
    limits: PLANS[plan].limits,
    features: FEATURES.filter((f) => features.has(f)),
    subscription: sub
      ? {
          status: sub.status,
          currentPeriodEnd: sub.currentPeriodEnd,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        }
      : null,
  };
}

export async function getUsage(db: Tx, orgId: string) {
  const [[m], [inv], [wf], [docs], [ai]] = await Promise.all([
    db.select({ n: count() }).from(memberships).where(eq(memberships.orgId, orgId)),
    db
      .select({ n: count() })
      .from(invitations)
      .where(
        and(
          eq(invitations.orgId, orgId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      ),
    db.select({ n: count() }).from(workflows).where(eq(workflows.orgId, orgId)),
    db
      .select({ bytes: sum(documents.sizeBytes) })
      .from(documents)
      .where(eq(documents.orgId, orgId)),
    db
      .select({ n: count() })
      .from(aiUsage)
      // Every model request counts, including failed or aborted ones (they may still be billed).
      .where(and(eq(aiUsage.orgId, orgId), gte(aiUsage.createdAt, sql`date_trunc('month', now())`))),
  ]);
  return {
    members: Number(m?.n ?? 0),
    pendingInvitations: Number(inv?.n ?? 0),
    workflows: Number(wf?.n ?? 0),
    storageBytes: Number(docs?.bytes ?? 0),
    aiRequestsThisMonth: Number(ai?.n ?? 0),
  };
}

const UPGRADE = "An owner can change the plan in Settings → Billing.";

export async function assertFeature(db: Tx, orgId: string, feature: Feature) {
  const e = await getEntitlements(db, orgId);
  if (!e.features.includes(feature)) {
    throw new AppError("FORBIDDEN", `${FEATURE_LABELS[feature]} is not included in your plan. ${UPGRADE}`);
  }
}

type LimitKind = "members" | "workflows" | "storage" | "aiRequests";

/**
 * Refuse an action that would exceed the plan. `adding` is the amount the
 * action adds (1 member, 1 workflow, N bytes, 1 request).
 */
export async function assertWithinLimit(db: Tx, orgId: string, kind: LimitKind, adding = 1) {
  const e = await getEntitlements(db, orgId);
  // Inside a transaction, serialize limit checks per organization so concurrent requests at the
  // limit cannot all pass (count-then-insert). The lock is held until the caller commits.
  await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .for("update");
  const limit =
    kind === "members"
      ? e.limits.members
      : kind === "workflows"
        ? e.limits.workflows
        : kind === "storage"
          ? e.limits.storageBytes
          : e.limits.aiRequestsPerMonth;
  if (limit === null) return;
  const u = await getUsage(db, orgId);
  const used =
    kind === "members"
      ? u.members + u.pendingInvitations
      : kind === "workflows"
        ? u.workflows
        : kind === "storage"
          ? u.storageBytes
          : u.aiRequestsThisMonth;
  if (used + adding > limit) {
    const what =
      kind === "members"
        ? `${limit} members (including pending invitations)`
        : kind === "workflows"
          ? `${limit} workflows`
          : kind === "storage"
            ? `${Math.round(limit / 1024 ** 3)} GB of document storage`
            : `${limit} assistant requests per month`;
    throw new AppError("FORBIDDEN", `Your ${PLANS[e.plan].name} plan allows ${what}. ${UPGRADE}`);
  }
}
