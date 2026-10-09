/**
 * Integration catalog. "available" integrations work in this build;
 * "planned" ones have an extension point only and are shown as not yet
 * available — FLOWOS never claims a connection it cannot make.
 */
export const INTEGRATION_IDS = [
  "slack",
  "microsoft_teams",
  "google_workspace",
  "microsoft_365",
  "hubspot",
  "quickbooks",
  "whatsapp_business",
] as const;
export type IntegrationId = (typeof INTEGRATION_IDS)[number];

/** Integrations that can receive messages from workflows in this build. */
export const MESSAGING_INTEGRATIONS = ["slack", "microsoft_teams"] as const;
export type MessagingIntegrationId = (typeof MESSAGING_INTEGRATIONS)[number];

export interface IntegrationDef {
  id: IntegrationId;
  name: string;
  category: "Messaging" | "Productivity" | "CRM" | "Accounting";
  description: string;
  availability: "available" | "planned";
  /** How a connection is made once available. */
  connect: "incoming_webhook" | "oauth";
  /** Shown on the connect form for incoming-webhook integrations. */
  setupHelp?: string;
}

export const INTEGRATIONS: readonly IntegrationDef[] = [
  {
    id: "slack",
    name: "Slack",
    category: "Messaging",
    description: "Post workflow messages to a Slack channel.",
    availability: "available",
    connect: "incoming_webhook",
    setupHelp:
      "In Slack, create an app with Incoming Webhooks enabled, add a webhook to the channel, and paste its URL (https://hooks.slack.com/services/…).",
  },
  {
    id: "microsoft_teams",
    name: "Microsoft Teams",
    category: "Messaging",
    description: "Post workflow messages to a Teams channel.",
    availability: "available",
    connect: "incoming_webhook",
    setupHelp:
      "In Teams, add the “Post to a channel when a webhook request is received” workflow (or an incoming webhook) to the channel and paste its URL.",
  },
  {
    id: "google_workspace",
    name: "Google Workspace",
    category: "Productivity",
    description: "Directory and calendar sync.",
    availability: "planned",
    connect: "oauth",
  },
  {
    id: "microsoft_365",
    name: "Microsoft 365",
    category: "Productivity",
    description: "Directory and calendar sync.",
    availability: "planned",
    connect: "oauth",
  },
  {
    id: "hubspot",
    name: "HubSpot",
    category: "CRM",
    description: "Create tasks and projects from deals.",
    availability: "planned",
    connect: "oauth",
  },
  {
    id: "quickbooks",
    name: "QuickBooks",
    category: "Accounting",
    description: "Send approved expenses to accounting.",
    availability: "planned",
    connect: "oauth",
  },
  {
    id: "whatsapp_business",
    name: "WhatsApp Business",
    category: "Messaging",
    description: "Notify people on WhatsApp.",
    availability: "planned",
    connect: "oauth",
  },
];

export const integrationById = (id: string) => INTEGRATIONS.find((i) => i.id === id);

/**
 * Allowed webhook hosts per messaging integration. Anything else is refused,
 * so a connection can never make the server call an internal address (SSRF).
 */
export const WEBHOOK_HOSTS: Record<MessagingIntegrationId, (host: string) => boolean> = {
  slack: (h) => h === "hooks.slack.com",
  microsoft_teams: (h) =>
    h.endsWith(".webhook.office.com") ||
    h.endsWith(".logic.azure.com") ||
    h.endsWith(".api.powerplatform.com"),
};

/** Validate an incoming-webhook URL for a provider; returns an error message or null. */
export function webhookUrlProblem(provider: MessagingIntegrationId, raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That is not a valid URL.";
  }
  if (url.protocol !== "https:") return "The webhook URL must start with https://.";
  if (url.username || url.password) return "The webhook URL must not contain credentials.";
  if (url.port && url.port !== "443") return "The webhook URL must use the standard HTTPS port.";
  if (!WEBHOOK_HOSTS[provider](url.hostname.toLowerCase())) {
    return provider === "slack"
      ? "Use a Slack incoming-webhook URL (https://hooks.slack.com/…)."
      : "Use a Microsoft Teams webhook URL (…webhook.office.com, …logic.azure.com or …api.powerplatform.com).";
  }
  if (url.pathname.length < 2) return "The webhook URL is incomplete.";
  return null;
}
