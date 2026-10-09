import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { and, eq, sql as sqlTag } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import {
  auditEvents,
  billingCustomers,
  featureFlags,
  invitations,
  memberships,
  subscriptions,
  webhookEvents,
} from "../src/db/schema";
import { assertWithinLimit } from "../src/modules/billing/entitlements";
import { purgeOldWebhookEvents } from "../src/modules/billing/service";
import {
  setBillingConfigForTests,
  setBillingGatewayForTests,
  StripeGateway,
  type BillingConfig,
  type BillingGateway,
} from "../src/modules/billing/gateway";
import { addMember, callerFor, createOrg, createUser, db } from "./helpers";

const CONFIG: BillingConfig = {
  // Never used for a network call: the test double below replaces every Stripe API request.
  secretKey: "sk_test_flowos_unit_tests_only",
  webhookSecret: "whsec_flowos_unit_tests_only",
  prices: { TEAM: "price_team_test", BUSINESS: "price_business_test" },
};

/** Records API calls instead of reaching Stripe; webhook verification is the real Stripe code. */
class RecordingGateway implements BillingGateway {
  customers: string[] = [];
  checkouts: Array<{ orgId: string; customerId: string; priceId: string }> = [];
  private readonly real = new StripeGateway(CONFIG);
  async createCustomer(input: { orgId: string }) {
    const id = `cus_${input.orgId.slice(0, 8)}_${this.customers.length}`;
    this.customers.push(id);
    return id;
  }
  async createCheckoutSession(input: { orgId: string; customerId: string; priceId: string }) {
    this.checkouts.push(input);
    return `https://checkout.stripe.test/${input.orgId}`;
  }
  async createPortalSession(input: { customerId: string }) {
    return `https://billing.stripe.test/${input.customerId}`;
  }
  verifyWebhook(rawBody: Buffer, signatureHeader: string) {
    return this.real.verifyWebhook(rawBody, signatureHeader);
  }
  /** Current subscription state "at Stripe", keyed by subscription id. */
  subs = new Map<string, unknown>();
  openCustomers = new Set<string>();
  async retrieveSubscription(id: string) {
    return (this.subs.get(id) ?? null) as Stripe.Subscription | null;
  }
  async hasOpenSubscription(customerId: string) {
    return this.openCustomers.has(customerId);
  }
}

let server: Server;
let base: string;
let gateway: RecordingGateway;
beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  setBillingConfigForTests(CONFIG);
  gateway = new RecordingGateway();
  setBillingGatewayForTests(gateway);
});
afterEach(() => {
  setBillingConfigForTests(undefined);
  setBillingGatewayForTests(undefined);
});

let eventSeq = 0;
function subscriptionEvent(
  type: "customer.subscription.created" | "customer.subscription.updated" | "customer.subscription.deleted",
  customer: string,
  opts: {
    price?: string;
    prices?: string[];
    status?: string;
    created?: number;
    id?: string;
    subId?: string;
  } = {},
) {
  return {
    id: opts.id ?? `evt_test_${Date.now()}_${eventSeq++}`,
    object: "event",
    type,
    created: opts.created ?? Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: opts.subId ?? `sub_for_${customer}`,
        object: "subscription",
        customer,
        status: opts.status ?? "active",
        cancel_at_period_end: false,
        metadata: {},
        items: {
          object: "list",
          data: (opts.prices ?? [opts.price ?? CONFIG.prices.TEAM!]).map((price, i) => ({
            id: `si_${i}`,
            price: { id: price },
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
          })),
        },
      },
    },
  };
}

/**
 * Deliver a signed event. For subscription events, Stripe's current state is set to the event's
 * object first (as when the event is fresh), unless `current` says otherwise: "keep" leaves the
 * current state unchanged (a stale or replayed event), null simulates a deleted subscription.
 */
async function deliver(
  event: object,
  opts: { secret?: string; timestamp?: number; current?: "keep" | null } = {},
) {
  const e = event as { type: string; data: { object: { id: string; status?: string } } };
  if (e.type.startsWith("customer.subscription.") && opts.current !== "keep") {
    if (opts.current === null) gateway.subs.delete(e.data.object.id);
    else
      gateway.subs.set(e.data.object.id, {
        ...e.data.object,
        status: e.type === "customer.subscription.deleted" ? "canceled" : e.data.object.status,
      });
  }
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: opts.secret ?? CONFIG.webhookSecret,
    timestamp: opts.timestamp,
  });
  return fetch(`${base}/api/billing/stripe/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body: payload,
  });
}

/** An org on the Free plan with a Stripe customer (as created by its first checkout). */
async function orgWithCustomer() {
  const ctx = await createOrg();
  await ctx.as(ctx.owner).billing.checkout({ plan: "TEAM" });
  const [c] = await db().select().from(billingCustomers).where(eq(billingCustomers.orgId, ctx.org.id));
  return { ...ctx, customer: c!.stripeCustomerId };
}

describe("billing disabled (self-hosted)", () => {
  it("has no limits and refuses checkout and webhooks", async () => {
    setBillingConfigForTests(null);
    setBillingGatewayForTests(undefined);
    const { owner, as } = await createOrg();
    const status = await as(owner).billing.status();
    expect(status).toMatchObject({ billingEnabled: false, plan: "SELF_HOSTED", purchasable: [] });
    expect(status.limits.members).toBeNull();
    await expect(as(owner).billing.checkout({ plan: "TEAM" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await deliver(subscriptionEvent("customer.subscription.created", "cus_x"))).status).toBe(404);
  });
});

describe("plans and limits", () => {
  it("Free plan: member, workflow and assistant limits are enforced", async () => {
    const { owner, org, as } = await createOrg();
    expect(await as(owner).billing.status()).toMatchObject({ plan: "FREE", billingEnabled: true });
    // Owner + 4 invitations reaches the 5-member limit.
    for (let i = 0; i < 4; i++)
      await as(owner).orgs.invite({ email: `m${i}-${randomUUID()}@x.test`, role: "MEMBER" });
    await expect(
      as(owner).orgs.invite({ email: `over-${randomUUID()}@x.test`, role: "MEMBER" }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("Free plan allows 5 members"),
    });
    const wf = {
      name: "W",
      trigger: "employee.created" as const,
      conditions: [],
      actions: [
        { type: "notify" as const, title: "x", body: "", recipient: "workflow_owner" as const, userId: null },
      ],
    };
    for (let i = 0; i < 3; i++) await as(owner).workflows.create({ ...wf, name: `W${i}` });
    await expect(as(owner).workflows.create(wf)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await as(owner).ai.status()).includedInPlan).toBe(false);
    await expect(assertWithinLimit(db(), org.id, "storage", 2 * 1024 ** 3)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("accepting an invitation re-checks the member limit", async () => {
    const { owner, org, as } = await createOrg();
    const invitee = await createUser("Ivy Invitee");
    const { token } = await as(owner).orgs.invite({ email: invitee.email, role: "MEMBER" });
    for (let i = 0; i < 3; i++)
      await as(owner).orgs.invite({ email: `p${i}-${randomUUID()}@x.test`, role: "MEMBER" });
    // 1 member + 4 open invitations = 5. A member added out of band (e.g. before a downgrade) fills the plan.
    const extra = await createUser("Out of band");
    await db().insert(memberships).values({ orgId: org.id, userId: extra.id, role: "MEMBER" });
    await expect(callerFor(invitee).orgs.acceptInvitation({ token })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // Nothing was half-applied: the invitation is still open.
    const [inv] = await db()
      .select()
      .from(invitations)
      .where(and(eq(invitations.orgId, org.id), eq(invitations.email, invitee.email)));
    expect(inv!.acceptedAt).toBeNull();
  });

  it("operator feature flags override plan features", async () => {
    const { owner, org, as } = await createOrg();
    expect((await as(owner).billing.status()).features).not.toContain("assistant");
    await db()
      .insert(featureFlags)
      .values({ orgId: org.id, feature: "assistant", enabled: true, reason: "beta" });
    expect((await as(owner).billing.status()).features).toContain("assistant");
  });
});

describe("checkout and portal", () => {
  it("only owners can start checkout; the Stripe customer is created once", async () => {
    const { owner, org, as } = await createOrg();
    const admin = await addMember(org.id, owner, "ADMIN");
    await expect(as(admin).billing.checkout({ plan: "TEAM" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const r1 = await as(owner).billing.checkout({ plan: "TEAM" });
    const r2 = await as(owner).billing.checkout({ plan: "BUSINESS" });
    expect(r1.url).toContain(org.id);
    expect(gateway.customers).toHaveLength(1);
    expect(gateway.checkouts.map((c) => c.priceId)).toEqual([CONFIG.prices.TEAM, CONFIG.prices.BUSINESS]);
    expect(new Set(gateway.checkouts.map((c) => c.customerId)).size).toBe(1);
    void r2;
    expect((await as(owner).billing.portal()).url).toContain("cus_");
    const audits = await db()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, org.id), eq(auditEvents.action, "billing.checkout_started")));
    expect(audits).toHaveLength(2);
  });
});

describe("Stripe webhooks", () => {
  it("rejects unsigned, wrongly signed and stale deliveries", async () => {
    const event = subscriptionEvent("customer.subscription.created", "cus_nobody");
    const unsigned = await fetch(`${base}/api/billing/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    expect(unsigned.status).toBe(400);
    expect((await deliver(event, { secret: "whsec_wrong" })).status).toBe(400);
    expect((await deliver(event, { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(400);
    expect(await db().select().from(webhookEvents).where(eq(webhookEvents.eventId, event.id))).toHaveLength(
      0,
    );
  });

  it("applies a subscription, ignores duplicates and out-of-order events, and downgrades on cancel", async () => {
    const { owner, org, as, customer } = await orgWithCustomer();
    const now = Math.floor(Date.now() / 1000);
    const created = subscriptionEvent("customer.subscription.created", customer, { created: now - 10 });
    const r = await deliver(created);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ received: true, outcome: "applied" });
    let status = await as(owner).billing.status();
    expect(status).toMatchObject({ plan: "TEAM", subscription: { status: "active" } });
    expect(status.limits.members).toBe(25);
    expect(status.features).toContain("assistant");

    // Redelivery of the same event: no second effect.
    expect(await (await deliver(created)).json()).toEqual({ received: true, outcome: "duplicate" });
    const audits = await db()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, org.id), eq(auditEvents.action, "billing.subscription_updated")));
    expect(audits).toHaveLength(1);

    // An older event arriving late (or twice in the same second) cannot roll the state back:
    // the current state is read from Stripe.
    const stale = subscriptionEvent("customer.subscription.updated", customer, {
      status: "past_due",
      created: now - 60,
    });
    await deliver(stale, { current: "keep" });
    expect((await as(owner).billing.status()).subscription?.status).toBe("active");

    // Upgrade to Business, then cancellation.
    await deliver(
      subscriptionEvent("customer.subscription.updated", customer, {
        price: CONFIG.prices.BUSINESS,
        created: now,
      }),
    );
    expect((await as(owner).billing.status()).plan).toBe("BUSINESS");
    await deliver(subscriptionEvent("customer.subscription.deleted", customer, { created: now + 1 }));
    status = await as(owner).billing.status();
    expect(status).toMatchObject({ plan: "FREE", subscription: { status: "canceled" } });
  });

  it("ignores events for unknown customers and unknown prices, and never trusts a claimed org id", async () => {
    const a = await orgWithCustomer();
    const b = await createOrg();
    expect(
      await (await deliver(subscriptionEvent("customer.subscription.created", "cus_unknown"))).json(),
    ).toMatchObject({
      outcome: "ignored",
    });
    expect(
      await (
        await deliver(
          subscriptionEvent("customer.subscription.created", a.customer, { price: "price_other" }),
        )
      ).json(),
    ).toMatchObject({ outcome: "ignored" });
    // checkout.session.completed claiming org B with org A's customer.
    const forged = {
      id: `evt_forged_${Date.now()}`,
      object: "event",
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "cs_1",
          object: "checkout.session",
          customer: a.customer,
          client_reference_id: b.org.id,
          metadata: {},
        },
      },
    };
    expect(await (await deliver(forged)).json()).toMatchObject({ outcome: "ignored" });
    expect(await db().select().from(subscriptions).where(eq(subscriptions.orgId, b.org.id))).toHaveLength(0);
    expect((await b.as(b.owner).billing.status()).plan).toBe("FREE");
  });

  it("failed payments notify owners; past_due keeps access, unpaid and incomplete fall back to Free", async () => {
    const { owner, org, as, customer } = await orgWithCustomer();
    const admin = await addMember(org.id, owner, "ADMIN");
    const now = Math.floor(Date.now() / 1000);
    await deliver(subscriptionEvent("customer.subscription.created", customer, { created: now - 30 }));

    const failed = {
      id: `evt_inv_${Date.now()}`,
      object: "event",
      type: "invoice.payment_failed",
      created: now - 20,
      data: { object: { id: "in_1", object: "invoice", customer, attempt_count: 1 } },
    };
    expect(await (await deliver(failed)).json()).toMatchObject({ outcome: "applied" });
    const ownerInbox = await as(owner).notifications.list({});
    expect(ownerInbox.items.some((n) => n.type === "BILLING_ISSUE")).toBe(true);
    // Only owners are told about billing.
    expect((await as(admin).notifications.list({})).items.some((n) => n.type === "BILLING_ISSUE")).toBe(
      false,
    );

    await deliver(
      subscriptionEvent("customer.subscription.updated", customer, { status: "past_due", created: now - 10 }),
    );
    expect(await as(owner).billing.status()).toMatchObject({
      plan: "TEAM",
      subscription: { status: "past_due" },
    });
    await deliver(
      subscriptionEvent("customer.subscription.updated", customer, { status: "unpaid", created: now - 5 }),
    );
    expect(await as(owner).billing.status()).toMatchObject({
      plan: "FREE",
      subscription: { status: "unpaid" },
    });
    await deliver(
      subscriptionEvent("customer.subscription.updated", customer, { status: "incomplete", created: now }),
    );
    expect((await as(owner).billing.status()).plan).toBe("FREE");
  });

  it("a failed-payment event for an unknown customer changes nothing", async () => {
    const r = await deliver({
      id: `evt_inv_unknown_${Date.now()}`,
      object: "event",
      type: "invoice.payment_failed",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: "in_2", object: "invoice", customer: "cus_nobody", attempt_count: 1 } },
    });
    expect(await r.json()).toMatchObject({ outcome: "ignored" });
  });

  it("a second subscription never replaces or downgrades the one granting access", async () => {
    const { owner, as, customer } = await orgWithCustomer();
    await deliver(subscriptionEvent("customer.subscription.created", customer, { subId: "sub_A" }));
    await deliver(
      subscriptionEvent("customer.subscription.created", customer, {
        subId: "sub_B",
        price: CONFIG.prices.BUSINESS,
      }),
    );
    expect((await as(owner).billing.status()).plan).toBe("TEAM");
    const inbox = await as(owner).notifications.list({});
    expect(inbox.items.some((n) => n.title.includes("two active subscriptions"))).toBe(true);
    await deliver(subscriptionEvent("customer.subscription.deleted", customer, { subId: "sub_B" }));
    expect(await as(owner).billing.status()).toMatchObject({
      plan: "TEAM",
      subscription: { status: "active" },
    });
  });

  it("checkout is refused while Stripe already has an open subscription for the customer", async () => {
    const { owner, as, customer } = await orgWithCustomer();
    gateway.openCustomers.add(customer);
    await expect(as(owner).billing.checkout({ plan: "TEAM" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("already exists at Stripe"),
    });
  });

  it("plans map across price changes, add-on items and deleted subscriptions", async () => {
    const { owner, as, customer } = await orgWithCustomer();
    // Add-on listed first: the plan is still found.
    await deliver(
      subscriptionEvent("customer.subscription.created", customer, {
        prices: ["price_addon", CONFIG.prices.TEAM!],
      }),
    );
    expect((await as(owner).billing.status()).plan).toBe("TEAM");
    // The operator moves Team to a new price and keeps the old one as legacy.
    setBillingConfigForTests({
      ...CONFIG,
      prices: { ...CONFIG.prices, TEAM: "price_team_v2" },
      legacyPrices: { TEAM: [CONFIG.prices.TEAM!] },
    });
    setBillingGatewayForTests(gateway);
    await deliver(subscriptionEvent("customer.subscription.updated", customer));
    expect((await as(owner).billing.status()).plan).toBe("TEAM");
    // Even with the old price forgotten entirely, a cancellation still applies.
    setBillingConfigForTests({ ...CONFIG, prices: { ...CONFIG.prices, TEAM: "price_team_v2" } });
    setBillingGatewayForTests(gateway);
    await deliver(subscriptionEvent("customer.subscription.deleted", customer));
    expect(await as(owner).billing.status()).toMatchObject({
      plan: "FREE",
      subscription: { status: "canceled" },
    });
  });

  it("a subscription that no longer exists at Stripe is treated as canceled", async () => {
    const { owner, as, customer } = await orgWithCustomer();
    await deliver(subscriptionEvent("customer.subscription.created", customer));
    await deliver(subscriptionEvent("customer.subscription.updated", customer), { current: null });
    expect((await as(owner).billing.status()).plan).toBe("FREE");
  });

  it("concurrent invitations at the limit cannot exceed it", async () => {
    const { owner, org, as } = await createOrg();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        as(owner).orgs.invite({ email: `race${i}-${randomUUID()}@x.test`, role: "MEMBER" }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4); // owner + 4 = Free limit 5
    const [{ n }] = (
      await db().execute<{ n: number }>(
        sqlTag`select count(*)::int as n from invitations where org_id = ${org.id} and accepted_at is null and revoked_at is null`,
      )
    ).rows as [{ n: number }];
    expect(n).toBe(4);
  });

  it("housekeeping purges webhook event ids older than 90 days only", async () => {
    await db()
      .insert(webhookEvents)
      .values([
        {
          provider: "stripe",
          eventId: `evt_old_${Date.now()}`,
          type: "x",
          outcome: "ignored",
          receivedAt: new Date(Date.now() - 91 * 86_400_000),
        },
        { provider: "stripe", eventId: `evt_new_${Date.now()}`, type: "x", outcome: "ignored" },
      ]);
    expect(await purgeOldWebhookEvents(db())).toBeGreaterThanOrEqual(1);
    const left = await db()
      .select()
      .from(webhookEvents)
      .where(sqlTag`${webhookEvents.eventId} like 'evt_old_%'`);
    expect(left).toHaveLength(0);
    expect(
      (
        await db()
          .select()
          .from(webhookEvents)
          .where(sqlTag`${webhookEvents.eventId} like 'evt_new_%'`)
      ).length,
    ).toBeGreaterThan(0);
  });
});
