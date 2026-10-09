import { and, eq, lt, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { ENTITLED_STATUSES, PLANS, type PlanId } from "@shared/billing";
import type { Database, Tx } from "../../db/client";
import {
  billingCustomers,
  memberships,
  organizations,
  subscriptions,
  users,
  webhookEvents,
} from "../../db/schema";
import { notify } from "../notifications/service";
import { env } from "../../env";
import { assertCan, can, type Actor } from "../../lib/actor";
import { audit } from "../../lib/audit";
import { AppError, badRequest } from "../../lib/errors";
import { getEntitlements, getUsage } from "./entitlements";
import { billingConfig, getBillingGateway, planForPriceId, type BillingGateway } from "./gateway";

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
  const open = e.subscription && !["canceled", "incomplete_expired"].includes(e.subscription.status);
  if (open) {
    throw badRequest("This organization already has a subscription. Use “Manage billing” to change it.");
  }
  const customerId = await customerFor(db, actor);
  // Our record can lag behind Stripe (webhook not yet received, e.g. a second browser tab).
  if (await gateway.hasOpenSubscription(customerId)) {
    throw badRequest("A subscription for this organization already exists at Stripe. Use “Manage billing”.");
  }
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

/** In-app notification to every owner of the organization (billing is owner business). */
async function notifyOwners(tx: Tx, orgId: string, message: { title: string; body: string }) {
  const owners = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.role, "OWNER")));
  for (const o of owners) {
    await notify(tx, {
      orgId,
      userId: o.userId,
      actorUserId: null,
      type: "BILLING_ISSUE",
      title: message.title,
      body: message.body,
      link: "/settings/billing",
    });
  }
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
export async function handleStripeEvent(
  db: Database,
  event: Stripe.Event,
  gateway: BillingGateway = requireGateway(),
): Promise<WebhookOutcome> {
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
    } else if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      const customerId = customerIdOf(invoice.customer as string | { id: string } | null);
      orgId = await orgForCustomer(tx, customerId);
      if (orgId) {
        outcome = "applied";
        await notifyOwners(tx, orgId, {
          title: "A subscription payment failed",
          body: "Stripe will retry the payment. Update the payment method under Settings → Billing → Manage billing.",
        });
        await audit(
          tx,
          { userId: null, orgId },
          {
            action: "billing.payment_failed",
            entityType: "organization",
            entityId: orgId,
            summary: "A subscription payment failed",
            metadata: { stripeEventId: event.id, attempt: invoice.attempt_count },
          },
        );
      }
    } else if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      // Events can arrive late, twice or out of order (one-second timestamps), so the event is
      // only a signal: the current state is read from Stripe and stored as is.
      const signalled = event.data.object;
      const current = await gateway.retrieveSubscription(signalled.id);
      const sub = current ?? { ...signalled, status: "canceled" as const };
      const customerId = customerIdOf(sub.customer as string | { id: string } | null)!;
      orgId = await orgForCustomer(tx, customerId);
      const [existing] = orgId
        ? await tx.select().from(subscriptions).where(eq(subscriptions.orgId, orgId)).for("update")
        : [];
      // Every item is checked, so add-ons or a reordered list do not hide the plan; a price that is
      // no longer configured keeps the plan already recorded for this subscription.
      const config = billingConfig()!;
      const mapped = sub.items.data
        .map((i) => planForPriceId(config, i.price.id))
        .find((p): p is "TEAM" | "BUSINESS" => p !== null);
      const sameSub = existing?.stripeSubscriptionId === sub.id;
      const plan = mapped ?? (sameSub ? existing!.plan : null);
      const entitled = (ENTITLED_STATUSES as readonly string[]).includes(sub.status);
      const existingEntitled =
        existing !== undefined && (ENTITLED_STATUSES as readonly string[]).includes(existing.status);

      if (orgId && plan && existing && !sameSub && existingEntitled) {
        // A second subscription for the same organization. Never let it replace (or, when it ends,
        // downgrade) the one that grants access; tell the owners so they can cancel the duplicate.
        outcome = "applied";
        if (entitled) {
          await audit(
            tx,
            { userId: null, orgId },
            {
              action: "billing.duplicate_subscription",
              entityType: "organization",
              entityId: orgId,
              summary: "A second active subscription was detected",
              metadata: { stripeEventId: event.id, kept: existing.stripeSubscriptionId, duplicate: sub.id },
            },
          );
          await notifyOwners(tx, orgId, {
            title: "Your organization has two active subscriptions",
            body: "Cancel the one you do not need in Settings → Billing → Manage billing to avoid paying twice.",
          });
        }
      } else if (orgId && plan) {
        const item = sub.items.data[0];
        const values = {
          orgId,
          plan,
          status: sub.status,
          stripeCustomerId: customerId,
          stripeSubscriptionId: sub.id,
          currentPeriodEnd: item?.current_period_end ? new Date(item.current_period_end * 1000) : null,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          lastEventCreatedAt: eventAt,
          updatedAt: new Date(),
        };
        await tx
          .insert(subscriptions)
          .values(values)
          .onConflictDoUpdate({ target: subscriptions.orgId, set: values });
        outcome = "applied";
        await audit(
          tx,
          { userId: null, orgId },
          {
            action: "billing.subscription_updated",
            entityType: "organization",
            entityId: orgId,
            summary: `Subscription ${sub.status}: ${PLANS[plan].name} plan`,
            metadata: { stripeEventId: event.id, stripeSubscriptionId: sub.id },
          },
        );
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

/**
 * Drop webhook event records after 90 days. Stripe retries a delivery for at
 * most 3 days, so older ids can no longer arrive again.
 */
export async function purgeOldWebhookEvents(db: Database): Promise<number> {
  const result = await db
    .delete(webhookEvents)
    .where(lt(webhookEvents.receivedAt, sql`now() - interval '90 days'`));
  return result.rowCount ?? 0;
}
