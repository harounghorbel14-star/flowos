import { and, eq } from "drizzle-orm";
import {
  INTEGRATIONS,
  integrationById,
  MESSAGING_INTEGRATIONS,
  webhookUrlProblem,
  type MessagingIntegrationId,
} from "@shared/integrations";
import { getDb, type Database, type Tx } from "../../db/client";
import { integrationConnections } from "../../db/schema";
import { assertCan, can, type Actor } from "../../lib/actor";
import { audit } from "../../lib/audit";
import { decryptSecret, encryptionConfigured, encryptSecret } from "../../lib/crypto";
import { badRequest, notFound } from "../../lib/errors";
import { assertFeature, getEntitlements } from "../billing/entitlements";
import { DeliveryError, getTransport } from "./transport";
import { RateLimiter } from "../../auth/rateLimit";

/** Connect and test-message calls per organization per minute (each can make an outbound request). */
export const integrationLimiter = new RateLimiter("integration", 10, 60_000);

const isMessaging = (id: string): id is MessagingIntegrationId =>
  (MESSAGING_INTEGRATIONS as readonly string[]).includes(id);

/** "https://hooks.slack.com/services/T0/B0/XYZ" → "hooks.slack.com/…/XYZ" (last 4 chars only). */
function hintFor(rawUrl: string) {
  const url = new URL(rawUrl);
  return `${url.hostname}/…/${url.pathname.replace(/\/$/, "").slice(-4)}`;
}

/** The catalog merged with this organization's connections. Secrets are never returned. */
export async function listIntegrations(db: Database, actor: Actor) {
  assertCan(actor, "member:read");
  const [rows, entitlements] = await Promise.all([
    db
      .select({
        provider: integrationConnections.provider,
        hint: integrationConnections.hint,
        status: integrationConnections.status,
        lastError: integrationConnections.lastError,
        lastDeliveryAt: integrationConnections.lastDeliveryAt,
        createdAt: integrationConnections.createdAt,
      })
      .from(integrationConnections)
      .where(eq(integrationConnections.orgId, actor.orgId)),
    getEntitlements(db, actor.orgId),
  ]);
  return {
    serverConfigured: encryptionConfigured(),
    includedInPlan: entitlements.features.includes("integrations"),
    canManage: can(actor, "integration:manage"),
    integrations: INTEGRATIONS.map((def) => ({
      ...def,
      connection: rows.find((r) => r.provider === def.id) ?? null,
    })),
  };
}

function assertConnectable(id: string): asserts id is MessagingIntegrationId {
  const def = integrationById(id);
  if (!def) throw notFound("Integration");
  if (def.availability !== "available" || !isMessaging(id)) {
    throw badRequest(`${def.name} is not available yet.`);
  }
  if (!encryptionConfigured()) throw badRequest("Integrations are not configured on this server.");
}

/** Message payload per provider. Text is plain; Slack mrkdwn control characters are escaped. */
function payloadFor(provider: MessagingIntegrationId, text: string) {
  if (provider === "slack") {
    return { text: text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") };
  }
  // RichTextBlock/TextRun is not Markdown-parsed, so text from records (task titles…) cannot
  // inject links or formatting into the channel.
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [{ type: "RichTextBlock", inlines: [{ type: "TextRun", text }] }],
        },
      },
    ],
  };
}

/** Connect (or replace) an incoming-webhook integration. Admins only; the URL is stored encrypted. */
export async function connectIntegration(
  db: Database,
  actor: Actor,
  input: { provider: string; webhookUrl: string },
) {
  assertCan(actor, "integration:manage");
  assertConnectable(input.provider);
  await assertFeature(db, actor.orgId, "integrations");
  await integrationLimiter.consume(`org:${actor.orgId}`, db);
  const url = input.webhookUrl.trim();
  const problem = webhookUrlProblem(input.provider, url);
  if (problem) throw badRequest(problem);
  const values = {
    orgId: actor.orgId,
    provider: input.provider,
    secretSealed: encryptSecret(url, `${actor.orgId}:${input.provider}`),
    hint: hintFor(url),
    status: "active" as const,
    lastError: null,
    createdByUserId: actor.userId,
    updatedAt: new Date(),
  };
  return db.transaction(async (tx) => {
    await tx
      .insert(integrationConnections)
      .values(values)
      .onConflictDoUpdate({
        target: [integrationConnections.orgId, integrationConnections.provider],
        set: values,
      });
    await audit(tx, actor, {
      action: "integration.connected",
      entityType: "integration",
      entityId: null,
      summary: `Connected ${integrationById(input.provider)!.name}`,
      metadata: { provider: input.provider, hint: values.hint },
    });
    return { ok: true as const, hint: values.hint };
  });
}

export async function disconnectIntegration(db: Database, actor: Actor, provider: string) {
  assertCan(actor, "integration:manage");
  return db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(integrationConnections)
      .where(
        and(eq(integrationConnections.orgId, actor.orgId), eq(integrationConnections.provider, provider)),
      )
      .returning({ id: integrationConnections.id });
    if (!removed) throw notFound("Connection");
    await audit(tx, actor, {
      action: "integration.disconnected",
      entityType: "integration",
      entityId: null,
      summary: `Disconnected ${integrationById(provider)?.name ?? provider}`,
      metadata: { provider },
    });
    return { ok: true as const };
  });
}

/**
 * Post a message through a connected integration and record the outcome on
 * the connection. Throws DeliveryError (retryable or not) on failure.
 */
export async function sendMessage(db: Tx, orgId: string, provider: MessagingIntegrationId, text: string) {
  const [conn] = await db
    .select()
    .from(integrationConnections)
    .where(and(eq(integrationConnections.orgId, orgId), eq(integrationConnections.provider, provider)));
  const name = integrationById(provider)!.name;
  if (!conn)
    throw new DeliveryError(`${name} is not connected. Connect it in Settings → Integrations.`, false);
  if (!encryptionConfigured())
    throw new DeliveryError("Integrations are not configured on this server.", false);
  try {
    await getTransport()(
      decryptSecret(conn.secretSealed, `${orgId}:${provider}`),
      payloadFor(provider, text),
    );
  } catch (err) {
    const message = err instanceof DeliveryError ? err.message : "The message could not be sent.";
    // Recorded on a separate connection: the caller's transaction (a workflow step) rolls back on
    // failure, and the connection's status must still show the problem.
    await getDb()
      .update(integrationConnections)
      .set({ status: "error", lastError: message, updatedAt: new Date() })
      .where(eq(integrationConnections.id, conn.id));
    throw err instanceof DeliveryError ? err : new DeliveryError(message, true);
  }
  await db
    .update(integrationConnections)
    .set({ status: "active", lastError: null, lastDeliveryAt: new Date(), updatedAt: new Date() })
    .where(eq(integrationConnections.id, conn.id));
}

/** "Send test message" from Settings. */
export async function sendTestMessage(db: Database, actor: Actor, provider: string) {
  assertCan(actor, "integration:manage");
  assertConnectable(provider);
  await assertFeature(db, actor.orgId, "integrations");
  await integrationLimiter.consume(`org:${actor.orgId}`, db);
  try {
    await sendMessage(db, actor.orgId, provider, "FLOWOS test message: this channel is connected.");
  } catch (err) {
    if (err instanceof DeliveryError) throw badRequest(err.message);
    throw err;
  }
  return { ok: true as const };
}
