import { and, eq, lte, ne, or } from "drizzle-orm";
import type Stripe from "stripe";
import { PLANS, type PlanId } from "@shared/billing";
import type { Database, Tx } from "../../db/client";
import { billingCustomers, organizations, subscriptions, users, webhookEvents } from "../../db/schema";
import { env } from "../../env";
import { assertCan, can, type Actor } from "../../lib/actor";
import { audit } from "../../lib/audit";
import { AppError, badRequest } from "../../lib/errors";
import { getEntitlements, getUsage } from "./entitlements";
import { billingConfig, getBillingGateway } from "./gateway";

export async function billingStatus(db: Database, actor: Actor) {
  const [entitlements, usage] = await Promise.all([
    getEntitlements(db, actor.orgId),
    getUsage(db, actor.orgId),
  ]);
  const config = billingConfig();
  return {
    ...entitlements,
    planName: PLANS[entitlements.plan].name,
    usage,
    canManage: can(actor, "billing:manage"),
    /** Paid plans available for checkout on this server (those with a configured Stripe Price). */
    purchasable: config
      ? (["TEAM", "BUSINESS"] as const)
          .filter((p) => config.prices[p])
          .map((p) => ({ id: p, name: PLANS[p].name, limits: PLANS[p].limits, features: PLANS[p].features }))
      : [],
  };
}

function requireGateway() {
  const gateway = getBillingGateway();
  if (!gateway) throw badRequest("Billing is not enabled on this server.");
  return gateway;
}

/** Find or create the organization's Stripe customer. */
async function customerFor(db: Database, actor: Actor) {
  const [existing] = await db.select().from(billingCustomers).where(eq(billingCustomers.orgId, actor.orgId));
  if (existing) return existing.stripeCustomerId;
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, actor.orgId));
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, actor.userId));
  const customerId = await requireGateway().createCustomer({
    orgId: actor.orgId,
    orgName: org!.name,
    email: user!.email,
  });
  await db
    .insert(billingCustomers)
    .values({ orgId: actor.orgId, stripeCustomerId: customerId })
    .onConflictDoNothing();
  const [row] = await db.select().from(billingCustomers).where(eq(billingCustomers.orgId, actor.orgId));
  return row!.stripeCustomerId;
}

/** Start Stripe Checkout for a paid plan; returns the hosted checkout URL. Owners only. */
export async function startCheckout(db: Database, actor: Actor, plan: PlanId) {
  assertCan(actor, "billing:manage");
  const gateway = requireGateway();
  const priceId = plan === "FREE" ? undefined : billingConfig()!.prices[plan];
  if (!priceId) throw badRequest("That plan is not available on this server.");
  const e = await getEntitlements(db, actor.orgId);
  if (e.subscription && e.plan !== "FREE") {
    throw badRequest("This organization already has a subscription. Use “Manage billing” to change it.");
  }
  const customerId = await customerFor(db, actor);
  const base = `${env().APP_ORIGIN}/settings/billing`;
  const url = await gateway.createCheckoutSession({
    orgId: actor.orgId,
    customerId,
    priceId,
    successUrl: `${base}?checkout=success`,
    cancelUrl: `${base}?checkout=cancelled`,
  });
  await audit(db, actor, {
    action: "billing.checkout_started",
    entityType: "organization",
    entityId: actor.orgId,
    summary: `Started checkout for the ${PLANS[plan].name} plan`,
  });
  return { url };
}

/** Stripe Customer Portal (change plan, payment method, invoices, cancel). Owners only. */
export async function openPortal(db: Database, actor: Actor) {
  assertCan(actor, "billing:manage");
  const gateway = requireGateway();
  const [customer] = await db.select().from(billingCustomers).where(eq(billingCustomers.orgId, actor.orgId));
  if (!customer) throw badRequest("This organization has no billing account yet.");
  return {
    url: await gateway.createPortalSession({
      customerId: customer.stripeCustomerId,
      returnUrl: `${env().APP_ORIGIN}/settings/billing`,
    }),
  };
}

function planForPrice(priceId: string | undefined): "TEAM" | "BUSINESS" | null {
  const prices = billingConfig()?.prices;
  if (!priceId || !prices) return null;
  if (priceId === prices.TEAM) return "TEAM";
  if (priceId === prices.BUSINESS) return "BUSINESS";
  return null;
}

const customerIdOf = (c: string | { id: string } | null) => (typeof c === "string" ? c : (c?.id ?? null));

async function orgForCustomer(db: Tx, customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  const [row] = await db
    .select({ orgId: billingCustomers.orgId })
    .from(billingCustomers)
    .where(eq(billingCustomers.stripeCustomerId, customerId));
  return row?.orgId ?? null;
}

export type WebhookOutcome = "applied" | "ignored" | "duplicate";

/**
 * Apply one verified Stripe event. The event id is recorded in the same
 * transaction as its effect, so a redelivered event is a no-op and a failed
 * one leaves nothing behind (Stripe retries it). Subscription updates older
 * than the last one applied are ignored (Stripe does not guarantee order).
 */
export async function handleStripeEvent(db: Database, event: Stripe.Event): Promise<WebhookOutcome> {
  return db.transaction(async (tx) => {
    const [fresh] = await tx
      .insert(webhookEvents)
      .values({ provider: "stripe", eventId: event.id, type: event.type, outcome: "pending" })
      .onConflictDoNothing()
      .returning({ eventId: webhookEvents.eventId });
    if (!fresh) return "duplicate";

    let orgId: string | null = null;
    let outcome: Exclude<WebhookOutcome, "duplicate"> = "ignored";
    const eventAt = new Date(event.created * 1000);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const customerId = customerIdOf(session.customer as string | { id: string } | null);
      const claimed = session.client_reference_id ?? session.metadata?.orgId ?? null;
      // Only trust the org id if this customer already belongs to that org (created by startCheckout).
      if (customerId && claimed && (await orgForCustomer(tx, customerId)) === claimed) {
        orgId = claimed;
        outcome = "applied";
      }
    } else if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const sub = event.data.object;
      const customerId = customerIdOf(sub.customer as string | { id: string } | null)!;
      orgId = await orgForCustomer(tx, customerId);
      const item = sub.items.data[0];
      const plan = planForPrice(item?.price.id);
      if (orgId && plan) {
        const status = event.type === "customer.subscription.deleted" ? "canceled" : sub.status;
        const values = {
          orgId,
          plan,
          status,
          stripeCustomerId: customerId,
          stripeSubscriptionId: sub.id,
          currentPeriodEnd: item?.current_period_end ? new Date(item.current_period_end * 1000) : null,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          lastEventCreatedAt: eventAt,
          updatedAt: new Date(),
        };
        const [written] = await tx
          .insert(subscriptions)
          .values(values)
          .onConflictDoUpdate({
            target: subscriptions.orgId,
            set: values,
            // Ignore stale events; a different (newer) subscription replaces a canceled one.
            setWhere: or(
              lte(subscriptions.lastEventCreatedAt, eventAt),
              and(eq(subscriptions.status, "canceled"), ne(subscriptions.stripeSubscriptionId, sub.id)),
            ),
          })
          .returning({ orgId: subscriptions.orgId });
        if (written) {
          outcome = "applied";
          await audit(
            tx,
            { userId: null, orgId },
            {
              action: "billing.subscription_updated",
              entityType: "organization",
              entityId: orgId,
              summary: `Subscription ${status}: ${PLANS[plan].name} plan`,
              metadata: { stripeEventId: event.id, stripeSubscriptionId: sub.id },
            },
          );
        }
      }
    }

    await tx
      .update(webhookEvents)
      .set({ outcome, orgId })
      .where(and(eq(webhookEvents.provider, "stripe"), eq(webhookEvents.eventId, event.id)));
    return outcome;
  });
}

export function assertBillingEnabled() {
  if (!billingConfig()) throw new AppError("NOT_FOUND", "Billing is not enabled on this server.");
}
