/**
 * Plans, limits and features. Prices are NOT defined here: they live in
 * Stripe (one Price per paid plan, referenced by environment variables), so
 * the application never shows an amount Stripe would not charge.
 *
 * The limits below are launch defaults chosen for this build, not
 * market-validated pricing decisions. Review them before selling.
 */
export const PLAN_IDS = ["FREE", "TEAM", "BUSINESS"] as const;
export type PlanId = (typeof PLAN_IDS)[number];
/** Used when billing is not configured on the server: no limits, every feature. */
export type EffectivePlanId = PlanId | "SELF_HOSTED";

export const FEATURES = ["assistant", "integrations"] as const;
export type Feature = (typeof FEATURES)[number];

export const FEATURE_LABELS: Record<Feature, string> = {
  assistant: "AI assistant",
  integrations: "Integrations (Slack, Microsoft Teams)",
};

export interface Limits {
  /** Members, counting open invitations. null = unlimited. */
  members: number | null;
  workflows: number | null;
  storageBytes: number | null;
  /** Assistant model requests per calendar month (UTC). */
  aiRequestsPerMonth: number | null;
}

export interface PlanDef {
  id: EffectivePlanId;
  name: string;
  limits: Limits;
  features: readonly Feature[];
}

const GB = 1024 ** 3;

export const PLANS: Record<EffectivePlanId, PlanDef> = {
  FREE: {
    id: "FREE",
    name: "Free",
    limits: { members: 5, workflows: 3, storageBytes: 1 * GB, aiRequestsPerMonth: 0 },
    features: [],
  },
  TEAM: {
    id: "TEAM",
    name: "Team",
    limits: { members: 25, workflows: 25, storageBytes: 25 * GB, aiRequestsPerMonth: 2_000 },
    features: ["assistant", "integrations"],
  },
  BUSINESS: {
    id: "BUSINESS",
    name: "Business",
    limits: { members: null, workflows: null, storageBytes: 250 * GB, aiRequestsPerMonth: 10_000 },
    features: ["assistant", "integrations"],
  },
  SELF_HOSTED: {
    id: "SELF_HOSTED",
    name: "Self-hosted (billing not enabled)",
    limits: { members: null, workflows: null, storageBytes: null, aiRequestsPerMonth: null },
    features: ["assistant", "integrations"],
  },
};

/** Stripe subscription statuses that grant the paid plan. `past_due` keeps access while Stripe retries payment. */
export const ENTITLED_STATUSES = ["active", "trialing", "past_due"] as const;
