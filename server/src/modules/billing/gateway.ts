import Stripe from "stripe";

/** Billing is enabled only when every Stripe setting is present. */
export interface BillingConfig {
  secretKey: string;
  webhookSecret: string;
  /** Stripe Price id per paid plan. */
  prices: { TEAM?: string; BUSINESS?: string };
}

let override: BillingConfig | null | undefined;

/** Read from the environment on each call (no caching), unless a test set an override. */
export function billingConfig(): BillingConfig | null {
  if (override !== undefined) return override;
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const prices = { TEAM: process.env.STRIPE_PRICE_TEAM, BUSINESS: process.env.STRIPE_PRICE_BUSINESS };
  if (!secretKey || !webhookSecret || (!prices.TEAM && !prices.BUSINESS)) return null;
  return { secretKey, webhookSecret, prices };
}

/** Tests only: force billing on with the given config, off with null, or back to the environment with undefined. */
export function setBillingConfigForTests(config: BillingConfig | null | undefined) {
  override = config;
  gateway = undefined;
}

/** The only Stripe-facing surface the service uses (a test double implements it in tests). */
export interface BillingGateway {
  createCustomer(input: { orgId: string; orgName: string; email: string }): Promise<string>;
  createCheckoutSession(input: {
    orgId: string;
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<string>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<string>;
  /** Verify the signature and parse the event; throws on an invalid signature or stale timestamp. */
  verifyWebhook(rawBody: Buffer, signatureHeader: string): Stripe.Event;
}

export class StripeGateway implements BillingGateway {
  private readonly stripe: Stripe;
  constructor(private readonly config: BillingConfig) {
    this.stripe = new Stripe(config.secretKey, { maxNetworkRetries: 2, timeout: 20_000 });
  }

  async createCustomer(input: { orgId: string; orgName: string; email: string }) {
    const customer = await this.stripe.customers.create(
      { name: input.orgName, email: input.email, metadata: { orgId: input.orgId } },
      // One customer per organization even if the request is retried.
      { idempotencyKey: `flowos-customer-${input.orgId}` },
    );
    return customer.id;
  }

  async createCheckoutSession(input: {
    orgId: string;
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
  }) {
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      customer: input.customerId,
      client_reference_id: input.orgId,
      line_items: [{ price: input.priceId, quantity: 1 }],
      subscription_data: { metadata: { orgId: input.orgId } },
      metadata: { orgId: input.orgId },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    if (!session.url) throw new Error("Stripe returned a checkout session without a URL");
    return session.url;
  }

  async createPortalSession(input: { customerId: string; returnUrl: string }) {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
    });
    return session.url;
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string) {
    // Default tolerance: 300 s, which rejects replayed old deliveries.
    return this.stripe.webhooks.constructEvent(rawBody, signatureHeader, this.config.webhookSecret);
  }
}

let gateway: BillingGateway | null | undefined;

export function getBillingGateway(): BillingGateway | null {
  if (gateway === undefined) {
    const config = billingConfig();
    gateway = config ? new StripeGateway(config) : null;
  }
  return gateway;
}

/** Tests only. */
export function setBillingGatewayForTests(g: BillingGateway | null | undefined) {
  gateway = g;
}
