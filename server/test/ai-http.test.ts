import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import superjson from "superjson";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { aiLimiter } from "../src/modules/ai/assistant";
import { setModelRuntime, type ModelRuntime } from "../src/modules/ai/runtime";
import { resetLimiters } from "./helpers";

let server: Server;
let base: string;
beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  setModelRuntime(null);
  return new Promise<void>((r) => server.close(() => r()));
});

const echo: ModelRuntime = {
  info: { provider: "scripted", model: "scripted-test-model", hosting: "self-hosted" },
  async health() {
    return { ok: true };
  },
  async run(_req, onText) {
    onText("Hello ");
    onText("there.");
    return {
      model: "scripted-test-model",
      content: [{ type: "text", text: "Hello there." }],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  },
};

async function trpc(path: string, input: unknown, headers: Record<string, string>) {
  const res = await fetch(`${base}/api/trpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-flowos-client": "web", ...headers },
    body: JSON.stringify(superjson.serialize(input)),
  });
  return { res, json: (await res.json()) as { result: { data: { json: Record<string, unknown> } } } };
}

describe("AI streaming endpoint", () => {
  it("streams NDJSON events for an authenticated member and enforces CSRF", async () => {
    await resetLimiters();
    await aiLimiter.reset();
    setModelRuntime(echo);
    const signup = await trpc(
      "auth.signup",
      { email: `ai-${randomUUID()}@e.test`, name: "Ai User", password: "longpassword1" },
      {},
    );
    const cookie = signup.res.headers.get("set-cookie")!.split(";")[0]!;
    const org = (await trpc("orgs.create", { name: "AI Org" }, { cookie })).json.result.data.json;
    const headers = { cookie, "x-flowos-org": String(org.id) };
    const convo = (await trpc("ai.createConversation", {}, headers)).json.result.data.json;
    const url = `${base}/api/ai/conversations/${String(convo.id)}/messages`;

    const noCsrf = await fetch(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(noCsrf.status).toBe(403);
    const anon = await fetch(url, {
      method: "POST",
      headers: { "x-flowos-client": "web", "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(anon.status).toBe(401);

    const res = await fetch(url, {
      method: "POST",
      headers: { ...headers, "x-flowos-client": "web", "content-type": "application/json" },
      body: JSON.stringify({ text: "Say hello" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const events = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; delta?: string });
    expect(
      events
        .filter((e) => e.type === "text")
        .map((e) => e.delta)
        .join(""),
    ).toBe("Hello there.");
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end" });
    // The run is announced first and reported last, from what actually happened.
    expect(events[0]!.type).toBe("run");
    expect(events.at(-2)!.type).toBe("report");

    // Without a model the same endpoint answers supported commands with FLOWOS rules, and
    // refuses to guess at anything else.
    setModelRuntime(null);
    const rules = async (text: string) =>
      (
        await (
          await fetch(url, {
            method: "POST",
            headers: { ...headers, "x-flowos-client": "web", "content-type": "application/json" },
            body: JSON.stringify({ text }),
          })
        ).text()
      )
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { type: string; delta?: string; run?: { mode: string } });
    const known = await rules("Which approvals are waiting for me?");
    expect(known[0]).toMatchObject({ type: "run", run: { mode: "rules" } });
    expect(known.find((e) => e.type === "text")?.delta).toBe(
      "No approval requests are waiting for your decision.",
    );
    const unknown = await rules("Write me a poem about logistics");
    expect(unknown.find((e) => e.type === "text")?.delta).toMatch(
      /^I can't interpret that request without a language model/,
    );
  });
});
