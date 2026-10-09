import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import superjson from "superjson";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { documents } from "../src/db/schema";
import { addDaysISO, todayISO } from "../src/lib/dates";
import { notifyExpiringDocuments } from "../src/modules/documents/service";
import { safeFileName, sniff } from "../src/storage/sniff";
import { addMember, createOrg, db, resetLimiters, type TestUser } from "./helpers";

let server: Server;
let base: string;
beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
const PASSWORD = "doc-password-123";

/** Sign in over HTTP and return the session cookie. */
async function cookieFor(user: TestUser) {
  resetLimiters();
  const res = await fetch(`${base}/api/trpc/auth.login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-flowos-client": "web" },
    body: JSON.stringify(superjson.serialize({ email: user.email, password: PASSWORD })),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

async function upload(
  cookie: string,
  orgId: string,
  meta: Record<string, unknown>,
  body: Buffer,
  headers: Record<string, string> = {},
) {
  return fetch(`${base}/api/documents/upload`, {
    method: "POST",
    headers: {
      cookie,
      "x-flowos-client": "web",
      "x-flowos-org": orgId,
      "content-type": "application/octet-stream",
      "x-flowos-meta": encodeURIComponent(JSON.stringify(meta)),
      ...headers,
    },
    body: new Uint8Array(body),
  });
}

const download = (cookie: string | null, orgId: string, id: string) =>
  fetch(`${base}/api/documents/${id}/download?org=${orgId}`, cookie ? { headers: { cookie } } : {});

/** Test users are created with a known password so they can log in over HTTP. */
async function orgWithPasswords() {
  const ctx = await createOrg();
  await db().execute(sql`update users set password_hash = ${await hash()} where id = ${ctx.owner.id}`);
  return ctx;
}
let cachedHash: string | undefined;
async function hash() {
  const { hashPassword } = await import("../src/auth/password");
  cachedHash ??= await hashPassword(PASSWORD);
  return cachedHash;
}
async function setPassword(user: TestUser) {
  await db().execute(sql`update users set password_hash = ${await hash()} where id = ${user.id}`);
}

describe("document storage", () => {
  it("sniffs content instead of trusting names", () => {
    expect(sniff(PDF, "evil.exe")?.mimeType).toBe("application/pdf");
    expect(sniff(Buffer.from("<html><script>alert(1)</script></html>"), "notes.txt")).toBeNull();
    expect(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "logo.svg")).toBeNull();
    expect(sniff(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]), "report.pdf")).toBeNull();
    expect(sniff(Buffer.from("PK\x03\x04rest"), "payload.zip")).toBeNull();
    expect(sniff(Buffer.from("a,b\n1,2\n"), "data.csv")?.mimeType).toBe("text/csv");
    expect(safeFileName("../../etc/passwd", "txt")).toBe("passwd.txt");
    expect(safeFileName('con"tr<act>.pdf', "pdf")).toBe("contract.pdf");
  });

  it("uploads, lists and downloads with safe headers and an audit trail", async () => {
    const { owner, org, as } = await orgWithPasswords();
    const cookie = await cookieFor(owner);
    const res = await upload(
      cookie,
      org.id,
      { title: "Master services agreement", category: "CONTRACT", fileName: "msa.final.PDF" },
      PDF,
    );
    expect(res.status).toBe(201);
    const doc = (await res.json()) as { id: string; fileName: string };
    expect(doc.fileName).toBe("msa.final.pdf");

    const list = await as(owner).documents.list({});
    expect(list.items[0]).toMatchObject({
      title: "Master services agreement",
      mimeType: "application/pdf",
      sizeBytes: PDF.length,
    });

    const dl = await download(cookie, org.id, doc.id);
    expect(dl.status).toBe(200);
    expect(Buffer.from(await dl.arrayBuffer()).equals(PDF)).toBe(true);
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment; filename="msa.final.pdf"/);
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(dl.headers.get("cache-control")).toBe("private, no-store");

    const log = await as(owner).audit.list({ entityType: "document" });
    expect(log.items.map((e) => e.action)).toEqual(["document.downloaded", "document.uploaded"]);
  });

  it("rejects disallowed types, empty and oversized files, and missing CSRF header", async () => {
    const { owner, org } = await orgWithPasswords();
    const cookie = await cookieFor(owner);
    expect(
      (await upload(cookie, org.id, { title: "x", fileName: "x.html" }, Buffer.from("<!doctype html><p>hi")))
        .status,
    ).toBe(400);
    expect((await upload(cookie, org.id, { title: "x", fileName: "x.pdf" }, Buffer.alloc(0))).status).toBe(
      400,
    );
    expect(
      (
        await upload(
          cookie,
          org.id,
          { title: "x", fileName: "x.pdf" },
          Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]),
        )
      ).status,
    ).toBe(413);
    expect(
      (await upload(cookie, org.id, { title: "x", fileName: "x.pdf" }, PDF, { "x-flowos-client": "" }))
        .status,
    ).toBe(403);
    expect(
      (await upload("flowos_session=forged", org.id, { title: "x", fileName: "x.pdf" }, PDF)).status,
    ).toBe(401);
  });

  it("blocks downloads across tenants, for non-members, and when logged out", async () => {
    const a = await orgWithPasswords();
    const b = await orgWithPasswords();
    const aCookie = await cookieFor(a.owner);
    const bCookie = await cookieFor(b.owner);
    const res = await upload(aCookie, a.org.id, { title: "A secret", fileName: "s.pdf" }, PDF);
    const { id } = (await res.json()) as { id: string };

    expect((await download(null, a.org.id, id)).status).toBe(401);
    expect((await download(bCookie, a.org.id, id)).status).toBe(403); // not a member of A
    expect((await download(bCookie, b.org.id, id)).status).toBe(404); // guessed id in own org
    await expect(b.as(b.owner).documents.update({ id, title: "pwned" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(b.as(b.owner).documents.delete({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await a.as(a.owner).documents.list({})).items[0]?.title).toBe("A secret");
  });

  it("restricted documents are visible only to managers, the uploader and their subject", async () => {
    const { owner, org, as } = await orgWithPasswords();
    const subject = await addMember(org.id, owner, "MEMBER", "Sam Subject");
    const bystander = await addMember(org.id, owner, "MEMBER", "Bea Bystander");
    const viewer = await addMember(org.id, owner, "VIEWER", "Vic Viewer");
    for (const u of [subject, bystander, viewer]) await setPassword(u);
    const employee = await as(owner).employees.create({
      firstName: "Sam",
      lastName: "Subject",
      email: subject.email,
      userId: subject.id,
    });

    const ownerCookie = await cookieFor(owner);
    const res = await upload(
      ownerCookie,
      org.id,
      {
        title: "Sam passport",
        category: "IDENTITY",
        visibility: "RESTRICTED",
        employeeId: employee.id,
        fileName: "p.pdf",
      },
      PDF,
    );
    const { id } = (await res.json()) as { id: string };
    const pub = await upload(
      ownerCookie,
      org.id,
      { title: "Handbook", category: "POLICY", fileName: "h.pdf" },
      PDF,
    );
    expect(pub.status).toBe(201);

    expect((await download(await cookieFor(subject), org.id, id)).status).toBe(200);
    expect((await download(await cookieFor(bystander), org.id, id)).status).toBe(404);
    expect((await as(bystander).documents.list({})).items.map((d) => d.title)).toEqual(["Handbook"]);
    expect((await as(bystander).search.global({ q: "passport" })).length).toBe(0);
    expect((await as(subject).search.global({ q: "passport" })).map((h) => h.kind)).toEqual(["document"]);
    // Viewers can read org documents but not upload.
    expect((await as(viewer).documents.list({})).items.map((d) => d.title)).toEqual(["Handbook"]);
    expect(
      (await upload(await cookieFor(viewer), org.id, { title: "x", fileName: "x.pdf" }, PDF)).status,
    ).toBe(403);
    // Members cannot delete others' documents.
    await expect(
      as(bystander).documents.delete({ id: (await as(bystander).documents.list({})).items[0]!.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects cross-tenant employee links and deletes bytes with the record", async () => {
    const a = await orgWithPasswords();
    const b = await orgWithPasswords();
    const bEmp = await b
      .as(b.owner)
      .employees.create({ firstName: "B", lastName: "E", email: `b-${randomUUID()}@e.test` });
    const cookie = await cookieFor(a.owner);
    expect(
      (await upload(cookie, a.org.id, { title: "x", employeeId: bEmp.id, fileName: "x.pdf" }, PDF)).status,
    ).toBe(400);

    const res = await upload(cookie, a.org.id, { title: "temp", fileName: "t.pdf" }, PDF);
    const { id } = (await res.json()) as { id: string };
    const [row] = await db()
      .select({ key: documents.storageKey })
      .from(documents)
      .where(eq(documents.id, id));
    const dir = `${process.env.STORAGE_DIR}/${row!.key.split("/")[0]}`;
    expect(await readdir(dir)).toContain(row!.key.split("/")[1]);
    await a.as(a.owner).documents.delete({ id });
    expect(await readdir(dir)).not.toContain(row!.key.split("/")[1]);
  });

  it("sends one expiry reminder per document", async () => {
    const { owner, org, as } = await orgWithPasswords();
    const cookie = await cookieFor(owner);
    await upload(
      cookie,
      org.id,
      {
        title: "Insurance certificate",
        category: "CERTIFICATE",
        expiresOn: addDaysISO(todayISO(), 5),
        fileName: "i.pdf",
      },
      PDF,
    );
    await upload(
      cookie,
      org.id,
      { title: "Far future", expiresOn: addDaysISO(todayISO(), 200), fileName: "f.pdf" },
      PDF,
    );
    await notifyExpiringDocuments(db());
    await notifyExpiringDocuments(db());
    const notes = (await as(owner).notifications.list({})).items.filter(
      (n) => n.type === "DOCUMENT_EXPIRING",
    );
    expect(notes.map((n) => n.title)).toEqual([
      `“Insurance certificate” expires on ${addDaysISO(todayISO(), 5)}`,
    ]);
    expect((await as(owner).documents.list({ expiring: true })).items.map((d) => d.title)).toEqual([
      "Insurance certificate",
    ]);
  });
});
