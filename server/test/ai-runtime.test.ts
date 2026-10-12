import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDaysISO } from "../src/lib/dates";
import { parseDue, routeIntent } from "../src/modules/ai/intents";
import { decide, NEVER_AUTONOMOUS } from "../src/modules/ai/policy";
import { ModelOutputError, ModelUnavailableError, selectRuntime } from "../src/modules/ai/runtime";
import { OpenAiCompatibleRuntime, toWireMessages } from "../src/modules/ai/runtime/openai-compatible";
import { findTool, TOOLS } from "../src/modules/ai/tools";
import { fitHistory, messagesFromStored } from "../src/modules/ai/transcript";
import type { Actor } from "../src/lib/actor";
import { ROLE_PERMISSIONS } from "@shared/permissions";

describe("intent router (rules mode)", () => {
  const today = "2026-10-12"; // a Monday
  it("parses due dates without guessing", () => {
    expect(parseDue("tomorrow", today)).toBe("2026-10-13");
    expect(parseDue("in 3 days", today)).toBe("2026-10-15");
    expect(parseDue("friday", today)).toBe("2026-10-16");
    expect(parseDue("monday", today)).toBe("2026-10-19"); // the next Monday, never today
    expect(parseDue("2026-11-02", today)).toBe("2026-11-02");
    expect(parseDue("2026-02-31", today)).toBeNull();
    expect(parseDue("soonish", today)).toBeNull();
  });

  it("recognises supported commands and their parameters", () => {
    expect(routeIntent("What should I prioritize today?")).toEqual({ kind: "priorities" });
    expect(routeIntent("What are the most urgent overdue tasks?")).toEqual({ kind: "overdue", mine: false });
    expect(routeIntent("show my overdue tasks")).toEqual({ kind: "overdue", mine: true });
    expect(routeIntent("Which projects appear to be blocked?")).toEqual({ kind: "blocked_projects" });
    expect(routeIntent("Which approvals are waiting for action?")).toEqual({ kind: "approvals" });
    expect(routeIntent("How can we unblock the Warehouse move project?")).toEqual({
      kind: "next_steps",
      project: "warehouse move",
    });
    expect(routeIntent("Mark #42 as in progress")).toEqual({
      kind: "set_status",
      taskNumber: 42,
      status: "IN_PROGRESS",
    });
    expect(routeIntent("create follow-up tasks for blocked tasks in project Launch")).toEqual({
      kind: "follow_up_blocked",
      project: "launch",
    });
    expect(routeIntent("Remember that I prefer Monday summaries")).toEqual({
      kind: "remember",
      content: "I prefer Monday summaries",
    });
    expect(
      routeIntent("Create task: Renew lease due in 5 days for Ana Diaz in project HQ move urgent priority"),
    ).toEqual({
      kind: "create_task",
      title: "Renew lease",
      dueDate: addDaysISO(new Date().toISOString().slice(0, 10), 5),
      priority: "URGENT",
      assignee: "Ana Diaz",
      project: "HQ move",
    });
    // Rules are literal: "for the offsite" reads as an assignee, which the planner then fails to resolve and reports.
    expect(routeIntent("add task Plan for the offsite")).toMatchObject({
      kind: "create_task",
      title: "Plan",
      assignee: "the offsite",
    });
  });

  it("does not claim to understand arbitrary requests", () => {
    for (const t of [
      "Write a poem",
      "Explain our Q3 strategy",
      "Who should we hire next?",
      "Delete all tasks",
      "",
    ]) {
      expect(routeIntent(t)).toBeNull();
    }
  });
});

describe("policy", () => {
  const actor = (role: keyof typeof ROLE_PERMISSIONS) =>
    ({ userId: "u", orgId: "o", role, permissions: ROLE_PERMISSIONS[role] }) as unknown as Actor;
  it("runs reads, confirms standard writes, auto-runs low-risk own-data writes, denies the rest", () => {
    const fresh = { steps: 0, writes: 0 };
    expect(decide(actor("VIEWER"), findTool("list_tasks"), fresh)).toEqual({ kind: "run" });
    expect(decide(actor("MEMBER"), findTool("create_task"), fresh)).toEqual({ kind: "confirm" });
    expect(decide(actor("VIEWER"), findTool("mark_notifications_read"), fresh)).toEqual({ kind: "auto" });
    expect(decide(actor("VIEWER"), findTool("create_task"), fresh)).toMatchObject({ kind: "deny" });
    expect(decide(actor("OWNER"), undefined, fresh)).toMatchObject({ kind: "deny" });
    expect(decide(actor("OWNER"), findTool("create_task"), { steps: 0, writes: 5 })).toMatchObject({
      kind: "deny",
    });
    expect(decide(actor("OWNER"), findTool("list_tasks"), { steps: 12, writes: 0 })).toMatchObject({
      kind: "deny",
    });
  });
  it("exposes no tool for operations that must stay with people", () => {
    const names = TOOLS.map((t) => t.name).join(" ");
    expect(names).not.toMatch(
      /delete|role|permission|approve|decide|billing|setting|workflow|send|slack|teams|email/,
    );
    expect(TOOLS.filter((t) => t.risk === "high")).toEqual([]);
    expect(NEVER_AUTONOMOUS.length).toBeGreaterThanOrEqual(6);
    // Every write is either confirmed or limited to the user's own data.
    for (const t of TOOLS.filter((x) => x.risk !== "read")) expect(["low", "standard"]).toContain(t.risk);
  });
});

describe("runtime selection", () => {
  it("is explicit and never falls back between providers", () => {
    expect(selectRuntime({})).toEqual({ runtime: null, configError: null });
    expect(selectRuntime({ FLOWOS_MODEL_PROVIDER: "none", ANTHROPIC_API_KEY: "k" }).runtime).toBeNull();
    const local = selectRuntime({
      FLOWOS_MODEL_URL: "http://localhost:8080/v1",
      FLOWOS_MODEL_NAME: "qwen2.5-7b",
    });
    expect(local.runtime?.info).toEqual({
      provider: "openai-compatible",
      model: "qwen2.5-7b",
      hosting: "self-hosted",
      endpoint: "http://localhost:8080/v1",
    });
    // A self-hosted URL wins over a hosted key when both are present.
    expect(
      selectRuntime({ FLOWOS_MODEL_URL: "http://m/v1", FLOWOS_MODEL_NAME: "m", ANTHROPIC_API_KEY: "k" })
        .runtime?.info.hosting,
    ).toBe("self-hosted");
    expect(selectRuntime({ ANTHROPIC_API_KEY: "k" }).runtime?.info).toMatchObject({
      provider: "anthropic",
      hosting: "hosted",
    });
    // A broken selection is reported, not replaced by another provider.
    expect(selectRuntime({ FLOWOS_MODEL_PROVIDER: "openai-compatible", ANTHROPIC_API_KEY: "k" })).toEqual({
      runtime: null,
      configError: "FLOWOS_MODEL_URL and FLOWOS_MODEL_NAME are required for openai-compatible.",
    });
    expect(
      selectRuntime({ FLOWOS_MODEL_URL: "http://user:secret@m/v1", FLOWOS_MODEL_NAME: "m" }).configError,
    ).toBe("FLOWOS_MODEL_URL must be an http(s) URL without credentials in it.");
    expect(selectRuntime({ FLOWOS_MODEL_PROVIDER: "gpt" }).configError).toMatch(
      /^FLOWOS_MODEL_PROVIDER must be one of/,
    );
  });
});

describe("OpenAI-compatible runtime (self-hosted servers)", () => {
  let server: Server;
  let base: string;
  let handler: (body: Record<string, unknown>) => { status?: number; chunks?: unknown[]; raw?: string };
  const seen: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}');
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        seen.push(parsed);
        const r = handler(parsed);
        if (r.status && r.status !== 200) {
          res.writeHead(r.status).end("{}");
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (r.raw) res.write(r.raw);
        for (const c of r.chunks ?? []) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    }).listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const runtime = () => new OpenAiCompatibleRuntime({ baseUrl: base, model: "local-test" });
  const request = {
    system: "sys",
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
    tools: [],
  };

  it("streams text and assembles tool calls split across chunks", async () => {
    handler = () => ({
      chunks: [
        { model: "local-test", choices: [{ delta: { content: "Checking " } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "call_1", function: { name: "list_", arguments: '{"over' } }],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { name: "tasks", arguments: 'due":true}' } }] },
              finish_reason: "tool_calls",
            },
          ],
        },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } },
      ],
    });
    const deltas: string[] = [];
    const res = await runtime().run(
      { ...request, tools: [{ name: "list_tasks", description: "d", inputSchema: { type: "object" } }] },
      (d) => deltas.push(d),
    );
    expect(deltas.join("")).toBe("Checking ");
    expect(res).toEqual({
      model: "local-test",
      content: [
        { type: "text", text: "Checking " },
        { type: "tool_call", id: "call_1", name: "list_tasks", input: { overdue: true } },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(seen.at(-1)).toMatchObject({ model: "local-test", stream: true, tool_choice: "auto" });
    expect((seen.at(-1)!.tools as unknown[])[0]).toEqual({
      type: "function",
      function: { name: "list_tasks", description: "d", parameters: { type: "object" } },
    });
    expect(await runtime().health()).toEqual({ ok: true });
  });

  it("separates an unreachable runtime from a bad answer", async () => {
    const dead = new OpenAiCompatibleRuntime({ baseUrl: "http://127.0.0.1:1/v1", model: "x" });
    await expect(dead.run(request, () => {})).rejects.toBeInstanceOf(ModelUnavailableError);
    expect((await dead.health()).ok).toBe(false);
    handler = () => ({ status: 503 });
    await expect(runtime().run(request, () => {})).rejects.toBeInstanceOf(ModelUnavailableError);
    handler = () => ({ status: 400 });
    await expect(runtime().run(request, () => {})).rejects.toBeInstanceOf(ModelOutputError);
    handler = () => ({
      chunks: [
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, id: "c", function: { name: "x", arguments: "{not json" } }] },
              finish_reason: "tool_calls",
            },
          ],
        },
      ],
    });
    await expect(runtime().run(request, () => {})).rejects.toBeInstanceOf(ModelOutputError);
    handler = () => ({ raw: "data: {garbage\n\n" });
    await expect(runtime().run(request, () => {})).rejects.toBeInstanceOf(ModelOutputError);
  });

  it("times out instead of hanging", async () => {
    const slow = createServer(() => {}).listen(0);
    await new Promise((r) => slow.once("listening", r));
    const rt = new OpenAiCompatibleRuntime({
      baseUrl: `http://127.0.0.1:${(slow.address() as AddressInfo).port}/v1`,
      model: "x",
      timeoutMs: 100,
    });
    await expect(rt.run(request, () => {})).rejects.toThrow("The model runtime timed out.");
    slow.closeAllConnections();
    slow.close();
  });

  it("translates the neutral transcript, keeping tool results next to their calls and dropping provider-only data", () => {
    const wire = toWireMessages("sys", [
      { role: "user", content: [{ type: "text", text: "q" }] },
      {
        role: "assistant",
        content: [
          { type: "opaque", provider: "anthropic", data: { type: "thinking" } },
          { type: "tool_call", id: "c1", name: "list_tasks", input: { overdue: true } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolCallId: "c1", content: "boom", isError: true },
          { type: "text", text: "and?" },
        ],
      },
    ]);
    expect(wire).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "list_tasks", arguments: '{"overdue":true}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "ERROR: boom" },
      { role: "user", content: "and?" },
    ]);
  });
});

describe("transcript compatibility", () => {
  it("reads conversations recorded before the engine (provider block format)", () => {
    const legacy = messagesFromStored([
      { role: "user", content: [{ type: "text", text: "old question" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "…", signature: "s" },
          { type: "tool_use", id: "toolu_1", name: "list_tasks", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "[]", is_error: true }],
      },
    ]);
    expect(legacy[1]!.content).toEqual([
      { type: "opaque", provider: "anthropic", data: { type: "thinking", thinking: "…", signature: "s" } },
      { type: "tool_call", id: "toolu_1", name: "list_tasks", input: {} },
    ]);
    expect(legacy[2]!.content).toEqual([
      { type: "tool_result", toolCallId: "toolu_1", content: "[]", isError: true },
    ]);
    expect(fitHistory(legacy)).toHaveLength(3);
  });
});
