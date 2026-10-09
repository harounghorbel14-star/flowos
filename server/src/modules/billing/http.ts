import express, { Router } from "express";
import { getDb } from "../../db/client";
import { logSafeError } from "../../lib/logging";
import { getBillingGateway } from "./gateway";
import { handleStripeEvent } from "./service";

/**
 * Stripe webhook endpoint. Not CSRF-guarded (Stripe is not a browser); the
 * signature over the raw body is the authentication. Responses: 400 for an
 * unverifiable request (Stripe will not retry), 500 when processing failed
 * (Stripe retries; nothing was recorded), 200 otherwise, including duplicates.
 */
export function billingWebhookRouter() {
  const r = Router();
  r.post("/stripe/webhook", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    const gateway = getBillingGateway();
    if (!gateway) {
      res.status(404).json({ error: "Billing is not enabled on this server." });
      return;
    }
    const signature = req.header("stripe-signature");
    let event;
    try {
      if (!signature || !Buffer.isBuffer(req.body)) throw new Error("missing signature or body");
      event = gateway.verifyWebhook(req.body, signature);
    } catch {
      res.status(400).json({ error: "Invalid signature." });
      return;
    }
    handleStripeEvent(getDb(), event, gateway)
      .then((outcome) => res.json({ received: true, outcome }))
      .catch((err: unknown) => {
        console.error("[billing] webhook processing failed:", logSafeError(err));
        res.status(500).json({ error: "Processing failed." });
      });
  });
  return r;
}
