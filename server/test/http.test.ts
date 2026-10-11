import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import superjson from "superjson";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { sessions } from "../src/db/schema";
import { hashToken } from "../src/lib/tokens";
import { eq } from "drizzle-orm";
import { db, resetLimiters } from "./helpers";

/** End-to-end checks through the real Express stack: cookies, CSRF guard, headers. */
let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await resetLimiters();
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function mutate(path: string, input: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/trpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-flowos-client": "web", ...headers },
    body: JSON.stringify(superjson.serialize(input)),
  });
}

function query(path: string, input: unknown, headers: Record<string, string> = {}) {
  const encoded = encodeURIComponent(JSON.stringify(superjson.serialize(input)));
  return fetch(`${base}/api/trpc/${path}?input=${encoded}`, { headers });
}

describe("HTTP layer", () => {
  it("sets an HttpOnly, SameSite=Lax session cookie on signup and uses it", async () => {
    const res = await mutate("auth.signup", {
      email: `h-${randomUUID()}@example.test`,
      name: "Http User",
      password: "longpassword1",
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/flowos_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const session = cookie.split(";")[0]!;
    const me = await query("auth.me", undefined, { cookie: session });
    const body = (await me.json()) as { result: { data: { json: { user: { name: string } } } } };
    expect(body.result.data.json.user.name).toBe("Http User");

    const logout = await mutate("auth.logout", undefined, { cookie: session });
    expect(logout.status).toBe(200);
    const after = await query("auth.me", undefined, { cookie: session });
    const afterBody = (await after.json()) as { result: { data: { json: unknown } } };
    expect(afterBody.result.data.json).toBeNull();
  });

  it("re-sends the session cookie only when the session is renewed", async () => {
    // Regression: every authenticated response carried Set-Cookie, so a request still in
    // flight when the user signed out (or the cookie was removed) put the cookie back.
    const res = await mutate("auth.signup", {
      email: `r-${randomUUID()}@example.test`,
      name: "Renew User",
      password: "longpassword1",
    });
    const session = res.headers.get("set-cookie")!.split(";")[0]!;
    const plain = await query("auth.me", undefined, { cookie: session });
    expect(plain.status).toBe(200);
    expect(plain.headers.get("set-cookie")).toBeNull();

    // Inside the renewal window (less than 15 of 30 days left) the expiry moves and the cookie follows.
    const id = hashToken(session.split("=")[1]!);
    await db()
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + 10 * 86_400_000) })
      .where(eq(sessions.id, id));
    const renewed = await query("auth.me", undefined, { cookie: session });
    const cookie = renewed.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^flowos_session=/);
    const expires = new Date(/Expires=([^;]+)/i.exec(cookie)![1]!).getTime();
    expect(expires - Date.now()).toBeGreaterThan(29 * 86_400_000);

    // Once renewed, ordinary requests stop re-sending it again.
    const after = await query("auth.me", undefined, { cookie: session });
    expect(after.headers.get("set-cookie")).toBeNull();
  });

  it("rejects mutations without the client header (CSRF)", async () => {
    const res = await fetch(`${base}/api/trpc/auth.login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(superjson.serialize({ email: "a@b.test", password: "x" })),
    });
    expect(res.status).toBe(403);
  });

  it("rejects mutations from a foreign origin", async () => {
    const res = await mutate(
      "auth.login",
      { email: "a@b.test", password: "x" },
      { origin: "https://evil.example" },
    );
    expect(res.status).toBe(403);
  });

  it("returns 401 for protected queries without a session and sends security headers", async () => {
    const res = await query("employees.list", {}, { "x-flowos-org": randomUUID() });
    expect(res.status).toBe(401);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("ignores forged session cookies", async () => {
    const res = await query("auth.me", undefined, { cookie: "flowos_session=forged-token-value" });
    const body = (await res.json()) as { result: { data: { json: unknown } } };
    expect(body.result.data.json).toBeNull();
  });
});
