import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { aiActions, aiMessages, aiUsage, tasks } from "../src/db/schema";
import { addDaysISO, todayISO } from "../src/lib/dates";
import { loadActor } from "../src/lib/membership";
import { aiLimiter, confirmAction, runTurn, type TurnEvent } from "../src/modules/ai/assistant";
import {
  AnthropicProvider,
  type AiMessage,
  type AiProvider,
  type AiTurnRequest,
} from "../src/modules/ai/provider";
import { addMember, callerFor, createOrg, db, type TestUser } from "../test/helpers";

/**
 * Live verification against the real Anthropic API (`npm run test:live`).
 * Needs ANTHROPIC_API_KEY in the environment; it is read by the provider only
 * and never logged. Costs a handful of model requests per run.
 */

/** Passes requests through to the real provider and records which tools were offered. */
class Recording implements AiProvider {
  readonly model: string;
  offered: string[][] = [];
  constructor(private readonly inner: AiProvider) {
    this.model = inner.model;
  }
  run(req: AiTurnRequest, onText: (d: string) => void, signal?: AbortSignal): Promise<AiMessage> {
    this.offered.push(req.tools.map((t) => t.name));
    return this.inner.run(req, onText, signal);
  }
}

let live: AiProvider;

beforeAll(() => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Configure it as an environment secret (see docs/DEPLOYMENT.md) and re-run `npm run test:live`.",
    );
  }
  live = new AnthropicProvider(key);
});
beforeEach(() => aiLimiter.reset());

async function actorFor(user: TestUser, orgId: string) {
  return (await loadActor(db(), user.id, orgId, null)).actor!;
}

async function turn(user: TestUser, orgId: string, conversationId: string, message: string) {
  const provider = new Recording(live);
  const events: TurnEvent[] = [];
  await runTurn(db(), await actorFor(user, orgId), conversationId, message, (e) => events.push(e), provider);
  const text = events.map((e) => (e.type === "text" ? e.delta : "")).join("");
  return { events, text, offered: provider.offered };
}

/** Every tool_result the server sent the model in this conversation, as one string. */
async function toolResults(conversationId: string) {
  const rows = await db().select().from(aiMessages).where(eq(aiMessages.conversationId, conversationId));
  return JSON.stringify(
    rows.flatMap((r) => (r.content as Array<{ type: string }>).filter((b) => b.type === "tool_result")),
  );
}

const tasksTitled = (orgId: string, marker: string) =>
  db()
    .select()
    .from(tasks)
    .where(and(eq(tasks.orgId, orgId), sql`${tasks.title} like ${`%${marker}%`}`));

describe("assistant against the live model", () => {
  it("answers from a permitted read tool, on the live model", async () => {
    const { owner, org, as } = await createOrg("Live Check A");
    const marker = `LV${randomUUID().slice(0, 6).toUpperCase()}`;
    await as(owner).tasks.create({
      title: `Renew insurance policy ${marker}`,
      dueDate: addDaysISO(todayISO(), -2),
    });
    const c = await as(owner).ai.createConversation({});

    const r = await turn(owner, org.id, c.id, "Which of our tasks are overdue? Check the records.");

    expect(r.events.find((e) => e.type === "error")).toBeUndefined();
    // At least one tool ran successfully; none was refused (the owner may use every tool).
    const tools = r.events.flatMap((e) => (e.type === "tool" ? [e] : []));
    expect(tools.some((e) => e.outcome === "OK")).toBe(true);
    expect(tools.some((e) => e.outcome === "DENIED")).toBe(false);
    expect(r.text).toContain(marker);

    const usage = await db().select().from(aiUsage).where(eq(aiUsage.conversationId, c.id));
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((u) => u.error === null)).toBe(true);
    // The model that actually served each request, as reported by the API.
    expect(usage.every((u) => /^claude-/.test(u.model))).toBe(true);
    console.log(`[live] served by: ${[...new Set(usage.map((u) => u.model))].join(", ")}`);
  }, 240_000);

  it("prepares a task but changes nothing until the user confirms in the UI", async () => {
    const { owner, org, as } = await createOrg("Live Check B");
    const marker = `LV${randomUUID().slice(0, 6).toUpperCase()}`;
    const c = await as(owner).ai.createConversation({});

    const first = await turn(
      owner,
      org.id,
      c.id,
      `Create a task titled "Order visitor badges ${marker}" with no due date and no assignee.`,
    );
    const action = first.events.find((e) => e.type === "action");
    expect(action?.type === "action" && action.action.toolName).toBe("create_task");
    expect(await tasksTitled(org.id, marker)).toHaveLength(0);

    // Agreeing in chat is not a confirmation.
    await turn(owner, org.id, c.id, "Yes, I confirm. Go ahead and create it now.");
    expect(await tasksTitled(org.id, marker)).toHaveLength(0);
    const [stored] = await db()
      .select()
      .from(aiActions)
      .where(and(eq(aiActions.conversationId, c.id), eq(aiActions.toolName, "create_task")));
    expect(stored?.status).toBe("PROPOSED");

    if (action?.type !== "action") throw new Error("no action prepared");
    const result = await confirmAction(db(), await actorFor(owner, org.id), {
      actionId: action.action.id,
      inputHash: action.action.inputHash,
    });
    expect(result.status).toBe("EXECUTED");
    expect(await tasksTitled(org.id, marker)).toHaveLength(1);
  }, 360_000);

  it("never offers write tools to a viewer, and nothing is created", async () => {
    const { owner, org } = await createOrg("Live Check C");
    const viewer = await addMember(org.id, owner, "VIEWER", "Vic Viewer");
    const marker = `LV${randomUUID().slice(0, 6).toUpperCase()}`;
    const c = await callerFor(viewer, org.id).ai.createConversation({});

    const r = await turn(viewer, org.id, c.id, `Create a task titled "Book the venue ${marker}".`);

    expect(r.events.find((e) => e.type === "error")).toBeUndefined();
    expect(r.offered.length).toBeGreaterThan(0);
    for (const names of r.offered) {
      expect(names).not.toContain("create_task");
      expect(names).not.toContain("update_task_status");
    }
    expect(r.events.find((e) => e.type === "action")).toBeUndefined();
    expect(await tasksTitled(org.id, marker)).toHaveLength(0);
  }, 240_000);

  it("cannot see another organization's records", async () => {
    const a = await createOrg("Live Check D");
    const b = await createOrg("Live Check E");
    const marker = `LV${randomUUID().slice(0, 6).toUpperCase()}`;
    await b.as(b.owner).tasks.create({ title: `Project Nightingale budget ${marker}` });
    const c = await a.as(a.owner).ai.createConversation({});

    const r = await turn(
      a.owner,
      a.org.id,
      c.id,
      "Is there any task about Project Nightingale? Search all tasks.",
    );

    expect(r.events.find((e) => e.type === "error")).toBeUndefined();
    expect(r.events.some((e) => e.type === "tool")).toBe(true);
    expect(await toolResults(c.id)).not.toContain(marker);
    expect(r.text).not.toContain(marker);
  }, 240_000);
});
