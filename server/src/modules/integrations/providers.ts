/**
 * Extension point for integrations that authenticate with OAuth (Google
 * Workspace, Microsoft 365, HubSpot, QuickBooks, WhatsApp Business). None is
 * implemented: they are listed as "planned" and cannot be connected. A
 * provider becomes available only when all of the following exist and are
 * tested: the OAuth flow below, encrypted token storage with refresh
 * (lib/crypto.ts), data synchronization with idempotent writes, verified
 * inbound webhooks (recorded in webhook_events like Stripe's), error
 * handling and tenant-isolation tests.
 */
import type { IntegrationId } from "@shared/integrations";
import type { Tx } from "../../db/client";

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

export interface OAuthIntegration {
  id: IntegrationId;
  /** Authorization URL; `state` must be a single-use, session-bound CSRF token. */
  authorizeUrl(input: { orgId: string; state: string; redirectUri: string }): string;
  exchangeCode(input: { code: string; redirectUri: string }): Promise<OAuthTokens>;
  refresh(tokens: OAuthTokens): Promise<OAuthTokens>;
  revoke(tokens: OAuthTokens): Promise<void>;
  /** Pull changes since the cursor and apply them through the regular services; returns the next cursor. */
  sync(tx: Tx, input: { orgId: string; tokens: OAuthTokens; cursor: string | null }): Promise<string | null>;
  /** Verify an inbound webhook's signature over the raw body; throws when invalid. */
  verifyWebhook?(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): { eventId: string; type: string };
}

/** Registered OAuth providers. Empty in this build. */
export const OAUTH_PROVIDERS: ReadonlyMap<IntegrationId, OAuthIntegration> = new Map();
