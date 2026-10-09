import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { webhookUrlProblem } from "@shared/integrations";
import { integrationConnections, workflowRuns } from "../src/db/schema";
import { decryptSecret, encryptSecret } from "../src/lib/crypto";
import { setBillingConfigForTests } from "../src/modules/billing/gateway";
import { DeliveryError, postJson, setTransportForTests } from "../src/modules/integrations/transport";
import { runWorkerOnce } from "../src/modules/workflows/engine";
import { addMember, createOrg, db } from "./helpers";

const SLACK_URL = "https://hooks.slack.com/services/T000/B000/secretPathXYZ1";
const TEAMS_URL = "https://contoso.webhook.office.com/webhookb2/abc/IncomingWebhook/def/secretPathTeams";

const sent: Array<{ url: string; body: unknown }> = [];
let failWith: DeliveryError | null = null;
function useRecorder() {
  sent.length = 0;
  failWith = null;
  setTransportForTests(async (url, body) => {
    if (failWith) throw failWith;
    sent.push({ url, body });
  });
}
afterEach(() => {
  setTransportForTests(undefined);
  setBillingConfigForTests(undefined);
});

async function drain() {
  for (let i = 0; i < 5; i++) {
    const { dispatched, results } = await runWorkerOnce(db());
    if (dispatched === 0 && results.length === 0) return;
  }
}

describe("webhook URL validation (SSRF)", () => {
  it.each([
    ["http://hooks.slack.com/services/x", "https://"],
    ["https://hooks.slack.com.evil.test/services/x", "Slack incoming-webhook"],
    ["https://169.254.169.254/latest/meta-data", "Slack incoming-webhook"],
    ["https://localhost/services/x", "Slack incoming-webhook"],
    ["https://user:pw@hooks.slack.com/services/x", "credentials"],
    ["https://hooks.slack.com:8443/services/x", "standard HTTPS port"],
    ["https://hooks.slack.com/", "incomplete"],
    ["not a url", "not a valid URL"],
  ])("refuses %s", (url, problem) => {
    expect(webhookUrlProblem("slack", url)).toContain(problem);
  });

  it("accepts the providers' real webhook hosts only", () => {
    expect(webhookUrlProblem("slack", SLACK_URL)).toBeNull();
    expect(webhookUrlProblem("microsoft_teams", TEAMS_URL)).toBeNull();
    expect(
      webhookUrlProblem("microsoft_teams", "https://prod-1.westus.logic.azure.com/workflows/x"),
    ).toBeNull();
    expect(webhookUrlProblem("microsoft_teams", SLACK_URL)).not.toBeNull();
  });
});

describe("secret storage", () => {
  it("encrypts with authentication; tampering is detected", () => {
    const sealed = encryptSecret(SLACK_URL);
    expect(sealed).not.toContain("secretPath");
    expect(decryptSecret(sealed)).toBe(SLACK_URL);
    const [v, iv, tag, data] = sealed.split(".");
    const flipped = Buffer.from(data!, "base64");
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decryptSecret([v, iv, tag, flipped.toString("base64")].join("."))).toThrow();
  });
});

describe("connections", () => {
  it("admins connect; the URL is stored encrypted and never returned", async () => {
    useRecorder();
    const { owner, org, as } = await createOrg();
    const member = await addMember(org.id, owner, "MEMBER");
    await expect(
      as(member).integrations.connect({ provider: "slack", webhookUrl: SLACK_URL }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const r = await as(owner).integrations.connect({ provider: "slack", webhookUrl: SLACK_URL });
    expect(r.hint).toBe("hooks.slack.com/…/XYZ1");
    const [row] = await db()
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.orgId, org.id));
    expect(row!.secretSealed).not.toContain("secretPath");
    const list = await as(member).integrations.list();
    expect(JSON.stringify(list)).not.toContain("secretPath");
    expect(list.integrations.find((i) => i.id === "slack")!.connection).toMatchObject({ status: "active" });
    // Another organization sees nothing.
    const other = await createOrg();
    expect(
      (await other.as(other.owner).integrations.list()).integrations.every((i) => i.connection === null),
    ).toBe(true);
    await expect(other.as(other.owner).integrations.disconnect({ provider: "slack" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses planned integrations and bad URLs", async () => {
    const { owner, as } = await createOrg();
    await expect(
      as(owner).integrations.connect({ provider: "hubspot", webhookUrl: SLACK_URL }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("not available yet"),
    });
    await expect(
      as(owner).integrations.connect({ provider: "slack", webhookUrl: "https://10.0.0.5/hook" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("the Free plan does not include integrations when billing is enabled", async () => {
    setBillingConfigForTests({
      secretKey: "sk_test_x",
      webhookSecret: "whsec_x",
      prices: { TEAM: "price_t" },
    });
    const { owner, as } = await createOrg();
    await expect(
      as(owner).integrations.connect({ provider: "slack", webhookUrl: SLACK_URL }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await as(owner).integrations.list()).includedInPlan).toBe(false);
  });

  it("test messages use each provider's format; failures are recorded on the connection", async () => {
    useRecorder();
    const { owner, org, as } = await createOrg();
    await as(owner).integrations.connect({ provider: "slack", webhookUrl: SLACK_URL });
    await as(owner).integrations.connect({ provider: "microsoft_teams", webhookUrl: TEAMS_URL });
    await as(owner).integrations.test({ provider: "slack" });
    await as(owner).integrations.test({ provider: "microsoft_teams" });
    expect(sent[0]).toEqual({
      url: SLACK_URL,
      body: { text: expect.stringContaining("FLOWOS test message") },
    });
    expect(sent[1]!.url).toBe(TEAMS_URL);
    expect(JSON.stringify(sent[1]!.body)).toContain("AdaptiveCard");

    failWith = new DeliveryError("The webhook no longer exists. Reconnect the integration.", false);
    await expect(as(owner).integrations.test({ provider: "slack" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const [row] = await db()
      .select()
      .from(integrationConnections)
      .where(and(eq(integrationConnections.orgId, org.id), eq(integrationConnections.provider, "slack")));
    expect(row).toMatchObject({ status: "error", lastError: expect.stringContaining("no longer exists") });
  });
});

describe("workflow action: send_message", () => {
  const messageWorkflow = (text: string) => ({
    name: `Announce ${randomUUID().slice(0, 4)}`,
    trigger: "employee.created" as const,
    conditions: [],
    actions: [{ type: "send_message" as const, provider: "slack" as const, text }],
  });

  it("requires a connection when saving, then posts the rendered message from the worker", async () => {
    useRecorder();
    const { owner, org, as } = await createOrg();
    await expect(as(owner).workflows.create(messageWorkflow("Welcome {{firstName}}"))).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Connect Slack"),
    });
    await as(owner).integrations.connect({ provider: "slack", webhookUrl: SLACK_URL });
    await as(owner).workflows.create(messageWorkflow("Welcome <b>{{firstName}}</b> & team"));
    await drain();
    sent.length = 0;
    await as(owner).employees.create({ firstName: "Noor", lastName: "N", email: `n-${randomUUID()}@x.test` });
    await drain();
    expect(sent).toEqual([{ url: SLACK_URL, body: { text: "Welcome &lt;b&gt;Noor&lt;/b&gt; &amp; team" } }]);
    const runs = await db().select().from(workflowRuns).where(eq(workflowRuns.orgId, org.id));
    expect(runs.every((r) => r.status === "SUCCEEDED")).toBe(true);
  });

  it("a deleted webhook fails the run at once; an outage is retried", async () => {
    useRecorder();
    const { owner, org, as } = await createOrg();
    await as(owner).integrations.connect({ provider: "slack", webhookUrl: SLACK_URL });
    await as(owner).workflows.create(messageWorkflow("Hi {{firstName}}"));
    await drain();

    failWith = new DeliveryError("The service responded 503.", true);
    await as(owner).employees.create({ firstName: "Ola", lastName: "O", email: `o-${randomUUID()}@x.test` });
    await drain();
    let [run] = await db().select().from(workflowRuns).where(eq(workflowRuns.orgId, org.id));
    expect(run).toMatchObject({ status: "PENDING", attempts: 1 }); // scheduled for retry

    failWith = new DeliveryError("The webhook no longer exists. Reconnect the integration.", false);
    await db()
      .update(workflowRuns)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(workflowRuns.id, run!.id));
    await drain();
    [run] = await db().select().from(workflowRuns).where(eq(workflowRuns.id, run!.id));
    expect(run).toMatchObject({ status: "FAILED", error: expect.stringContaining("no longer exists") });
  });
});

describe("HTTP transport", () => {
  let server: Server;
  let base: string;
  const status = { code: 200 };
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://169.254.169.254/" }).end();
        return;
      }
      res.writeHead(status.code).end("echo of the request would go here");
    }).listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("classifies responses and never follows redirects", async () => {
    status.code = 200;
    await expect(postJson(`${base}/ok`, { text: "x" })).resolves.toBeUndefined();
    status.code = 404;
    await expect(postJson(`${base}/gone`, {})).rejects.toMatchObject({ retryable: false });
    status.code = 503;
    await expect(postJson(`${base}/busy`, {})).rejects.toMatchObject({ retryable: true });
    status.code = 400;
    const err = await postJson(`${base}/bad`, {}).catch((e: unknown) => e as DeliveryError);
    expect(err).toMatchObject({ retryable: false });
    expect((err as Error).message).not.toContain("echo");
    await expect(postJson(`${base}/redirect`, {})).rejects.toBeInstanceOf(DeliveryError);
  });
});
