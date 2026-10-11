import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { passwordResetLimiter } from "../src/auth/rateLimit";
import { passwordResetTokens, sessions } from "../src/db/schema";
import { setMailerForTests, smtpMailer, type MailMessage } from "../src/lib/mail";
import * as auth from "../src/modules/auth/service";
import { anonCaller, createUser, db } from "./helpers";

const meta = () => ({ ip: randomUUID(), userAgent: "vitest" });
let outbox: MailMessage[] = [];

beforeEach(async () => {
  outbox = [];
  setMailerForTests({ send: async (m) => void outbox.push(m) });
  await passwordResetLimiter.reset();
});
afterEach(() => setMailerForTests(undefined));

async function request(email: string) {
  const res = await auth.requestPasswordReset(db(), { email }, meta());
  await res.delivery;
  return res;
}
const linkIn = (m: MailMessage) => /https?:\/\/\S+\/reset-password\/([A-Za-z0-9_-]+)/.exec(m.text);
const tokenFrom = (m: MailMessage) => linkIn(m)![1]!;

describe("forgot password", () => {
  it("emails a single-use link to an existing account; the token is stored only as a hash", async () => {
    const user = await createUser("Rita Reset");
    const res = await request(user.email.toUpperCase());
    expect(res.emailEnabled).toBe(true);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe(user.email);
    expect(outbox[0]!.subject).toBe("Reset your FLOWOS password");
    expect(linkIn(outbox[0]!)![0]).toMatch(/^http:\/\/localhost:5173\/reset-password\//);

    const token = tokenFrom(outbox[0]!);
    const rows = await db().select().from(passwordResetTokens).where(eq(passwordResetTokens.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toContain(token);
    expect(rows[0]!.expiresAt.getTime() - Date.now()).toBeGreaterThan(59 * 60_000);
  });

  it("answers the same for an unknown email and sends nothing", async () => {
    const res = await anonCaller({ ip: randomUUID() }).auth.requestPasswordReset({
      email: `nobody-${randomUUID()}@example.test`,
    });
    expect(res).toEqual({ ok: true, emailEnabled: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(outbox).toHaveLength(0);
  });

  it("without email configured it says so and creates no link", async () => {
    setMailerForTests(null);
    const user = await createUser();
    const res = await anonCaller({ ip: randomUUID() }).auth.requestPasswordReset({ email: user.email });
    expect(res).toEqual({ ok: true, emailEnabled: false });
    const rows = await db().select().from(passwordResetTokens).where(eq(passwordResetTokens.userId, user.id));
    expect(rows).toHaveLength(0);
  });

  it("resets the password once, signs out every session, and the old password stops working", async () => {
    const user = await createUser();
    await anonCaller({ ip: randomUUID() }).auth.login({ email: user.email, password: "correct-horse-42" });
    expect((await db().select().from(sessions).where(eq(sessions.userId, user.id))).length).toBe(2);

    await request(user.email);
    const token = tokenFrom(outbox[0]!);
    const caller = anonCaller({ ip: randomUUID() });
    await expect(caller.auth.resetPassword({ token, password: "brand-new-pass-7" })).resolves.toEqual({
      ok: true,
    });
    expect(await db().select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0);

    await expect(
      anonCaller({ ip: randomUUID() }).auth.login({ email: user.email, password: "correct-horse-42" }),
    ).rejects.toThrow("Incorrect email or password.");
    await expect(
      anonCaller({ ip: randomUUID() }).auth.login({ email: user.email, password: "brand-new-pass-7" }),
    ).resolves.toMatchObject({ user: { id: user.id } });

    await expect(caller.auth.resetPassword({ token, password: "another-pass-8" })).rejects.toThrow(
      "This reset link is invalid or has expired.",
    );
  });

  it("rejects expired, unknown and superseded links, and weak passwords", async () => {
    const user = await createUser();
    const caller = anonCaller({ ip: randomUUID() });

    await request(user.email);
    const first = tokenFrom(outbox[0]!);
    await request(user.email);
    const second = tokenFrom(outbox[1]!);
    await expect(caller.auth.resetPassword({ token: first, password: "brand-new-pass-7" })).rejects.toThrow(
      "invalid or has expired",
    );

    await expect(caller.auth.resetPassword({ token: second, password: "short1" })).rejects.toThrow(
      "Use at least 10 characters.",
    );

    await db()
      .update(passwordResetTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(passwordResetTokens.userId, user.id));
    await expect(caller.auth.resetPassword({ token: second, password: "brand-new-pass-7" })).rejects.toThrow(
      "invalid or has expired",
    );

    await expect(
      caller.auth.resetPassword({ token: "x".repeat(43), password: "brand-new-pass-7" }),
    ).rejects.toThrow("invalid or has expired");
  });

  it("limits requests per email, whether or not the account exists", async () => {
    const email = `limit-${randomUUID()}@example.test`;
    for (let i = 0; i < 5; i++) await anonCaller({ ip: randomUUID() }).auth.requestPasswordReset({ email });
    await expect(anonCaller({ ip: randomUUID() }).auth.requestPasswordReset({ email })).rejects.toThrow(
      "Too many attempts",
    );
  });
});

/**
 * The real SMTP mailer against a minimal local SMTP server: proves the message
 * actually goes over the wire with the right envelope and link.
 */
describe("SMTP delivery", () => {
  let server: Server;
  const received: Array<{ from: string; to: string[]; data: string }> = [];
  afterAll(() => new Promise<void>((r) => server?.close(() => r())));

  it("sends the reset email over SMTP", async () => {
    server = createServer((socket) => {
      let buffer = "";
      let inData = false;
      const mail = { from: "", to: [] as string[], data: "" };
      const reply = (line: string) => socket.write(`${line}\r\n`);
      reply("220 localhost test SMTP");
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let i: number;
        while ((i = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          if (inData) {
            if (line === ".") {
              inData = false;
              received.push({ ...mail });
              reply("250 queued");
            } else mail.data += `${line}\n`;
            continue;
          }
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === "MAIL") mail.from = line;
          if (cmd === "RCPT") mail.to.push(line);
          if (cmd === "DATA") inData = true;
          if (cmd === "DATA") reply("354 go ahead");
          else if (cmd === "QUIT") {
            reply("221 bye");
            socket.end();
          } else reply(cmd === "EHLO" || cmd === "HELO" ? "250 localhost" : "250 ok");
        }
      });
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };

    const user = await createUser("Sam Smtp");
    setMailerForTests(smtpMailer(`smtp://127.0.0.1:${port}`, "FLOWOS <no-reply@example.test>"));
    await request(user.email);

    expect(received).toHaveLength(1);
    expect(received[0]!.from).toContain("no-reply@example.test");
    expect(received[0]!.to.join()).toContain(user.email);
    // Undo quoted-printable soft line breaks and escapes before looking for the link.
    const body = received[0]!.data
      .replace(/=\n/g, "")
      .replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    expect(body).toContain("Subject: Reset your FLOWOS password");
    expect(body).toMatch(/http:\/\/localhost:5173\/reset-password\/[A-Za-z0-9_-]{43}/);
  });
});
