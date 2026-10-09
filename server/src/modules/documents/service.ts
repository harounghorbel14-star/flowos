import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, ilike, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { DocumentCategory, DocumentVisibility } from "@shared/domain";
import type { Database, Tx } from "../../db/client";
import { documents, employees, users } from "../../db/schema";
import { assertCan, can, type Actor } from "../../lib/actor";
import { audit, diff } from "../../lib/audit";
import { addDaysISO, todayISO } from "../../lib/dates";
import { badRequest, forbidden, notFound } from "../../lib/errors";
import { likePattern, offsetOf, toPage, type PageInput } from "../../lib/pagination";
import { requireEmployee } from "../../lib/refs";
import { safeFileName, sniff } from "../../storage/sniff";
import { getStorage, newStorageKey } from "../../storage/storage";
import { notify } from "../notifications/service";
import { assertWithinLimit } from "../billing/entitlements";

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const EXPIRY_WARNING_DAYS = 14;

export interface DocumentMeta {
  title: string;
  description?: string | null;
  category: DocumentCategory;
  visibility: DocumentVisibility;
  employeeId?: string | null;
  expiresOn?: string | null;
}

/**
 * Rows the actor may see, expressed in SQL so unauthorized documents are
 * never loaded: ORG documents for anyone with document:read; RESTRICTED ones
 * only for document managers, the uploader, and the employee they concern.
 */
export function visibleTo(actor: Actor): SQL | undefined {
  if (can(actor, "document:manage")) return undefined;
  return or(
    eq(documents.visibility, "ORG"),
    eq(documents.uploadedByUserId, actor.userId),
    sql`${documents.employeeId} in (select ${employees.id} from ${employees} where ${employees.orgId} = ${actor.orgId} and ${employees.userId} = ${actor.userId})`,
  );
}

const columns = {
  id: documents.id,
  title: documents.title,
  description: documents.description,
  category: documents.category,
  visibility: documents.visibility,
  employeeId: documents.employeeId,
  employeeFirstName: employees.firstName,
  employeeLastName: employees.lastName,
  fileName: documents.fileName,
  mimeType: documents.mimeType,
  sizeBytes: documents.sizeBytes,
  expiresOn: documents.expiresOn,
  uploadedByUserId: documents.uploadedByUserId,
  uploadedByName: users.name,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
};

function baseQuery(db: Tx) {
  return db
    .select(columns)
    .from(documents)
    .leftJoin(employees, and(eq(employees.orgId, documents.orgId), eq(employees.id, documents.employeeId)))
    .leftJoin(users, eq(users.id, documents.uploadedByUserId));
}

export async function listDocuments(
  db: Database,
  actor: Actor,
  input: PageInput & {
    search?: string;
    category?: DocumentCategory;
    employeeId?: string;
    expiring?: boolean;
  },
) {
  assertCan(actor, "document:read");
  const filters: (SQL | undefined)[] = [eq(documents.orgId, actor.orgId), visibleTo(actor)];
  if (input.search) {
    const p = likePattern(input.search);
    filters.push(
      or(ilike(documents.title, p), ilike(documents.fileName, p), ilike(documents.description, p)),
    );
  }
  if (input.category) filters.push(eq(documents.category, input.category));
  if (input.employeeId) filters.push(eq(documents.employeeId, input.employeeId));
  if (input.expiring) {
    filters.push(isNotNull(documents.expiresOn), lte(documents.expiresOn, addDaysISO(todayISO(), 30)));
  }
  const where = and(...filters);
  const [items, [total]] = await Promise.all([
    baseQuery(db)
      .where(where)
      .orderBy(...(input.expiring ? [asc(documents.expiresOn)] : [desc(documents.createdAt)]))
      .limit(input.pageSize)
      .offset(offsetOf(input)),
    db.select({ n: count() }).from(documents).where(where),
  ]);
  return toPage(
    items.map((d) => ({ ...d, canEdit: canEdit(actor, d) })),
    total?.n ?? 0,
    input,
  );
}

function canEdit(actor: Actor, d: { uploadedByUserId: string | null }) {
  return (
    can(actor, "document:manage") || (can(actor, "document:upload") && d.uploadedByUserId === actor.userId)
  );
}

/** Load a document the actor may see, or 404 — identical for "missing" and "not allowed". */
export async function getVisibleDocument(db: Tx, actor: Actor, id: string) {
  assertCan(actor, "document:read");
  const [doc] = await db
    .select({ ...columns, storageKey: documents.storageKey, sha256: documents.sha256 })
    .from(documents)
    .leftJoin(employees, and(eq(employees.orgId, documents.orgId), eq(employees.id, documents.employeeId)))
    .leftJoin(users, eq(users.id, documents.uploadedByUserId))
    .where(and(eq(documents.orgId, actor.orgId), eq(documents.id, id), visibleTo(actor)))
    .limit(1);
  if (!doc) throw notFound("Document");
  return doc;
}

async function validateMeta(tx: Tx, actor: Actor, meta: Partial<DocumentMeta>) {
  if (meta.employeeId) await requireEmployee(tx, actor.orgId, meta.employeeId);
}

export async function uploadDocument(
  db: Database,
  actor: Actor,
  meta: DocumentMeta,
  fileName: string,
  data: Buffer,
) {
  assertCan(actor, "document:upload");
  if (data.length === 0) throw badRequest("The file is empty.");
  if (data.length > MAX_DOCUMENT_BYTES) throw badRequest("Files can be at most 10 MB.");
  const kind = sniff(data, fileName);
  if (!kind)
    throw badRequest(
      "Unsupported file type. Upload a PDF, image (PNG/JPEG), Office document or plain text file.",
    );

  await assertWithinLimit(db, actor.orgId, "storage", data.length);
  const storageKey = newStorageKey();
  const storage = getStorage();
  await storage.put(storageKey, data);
  try {
    return await db.transaction(async (tx) => {
      await validateMeta(tx, actor, meta);
      const [doc] = await tx
        .insert(documents)
        .values({
          orgId: actor.orgId,
          title: meta.title,
          description: meta.description ?? null,
          category: meta.category,
          visibility: meta.visibility,
          employeeId: meta.employeeId ?? null,
          expiresOn: meta.expiresOn ?? null,
          fileName: safeFileName(fileName, kind.extension),
          mimeType: kind.mimeType,
          sizeBytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
          storageKey,
          uploadedByUserId: actor.userId,
        })
        .returning({ id: documents.id, title: documents.title, fileName: documents.fileName });
      await audit(tx, actor, {
        action: "document.uploaded",
        entityType: "document",
        entityId: doc!.id,
        summary: `Uploaded “${doc!.title}”`,
        metadata: {
          fileName: doc!.fileName,
          sizeBytes: data.length,
          mimeType: kind.mimeType,
          visibility: meta.visibility,
        },
      });
      return doc!;
    });
  } catch (err) {
    // Never leave orphaned bytes behind when the record could not be saved.
    await storage.delete(storageKey).catch(() => undefined);
    throw err;
  }
}

/** Returns the bytes for an authorized download and records it in the audit log. */
export async function downloadDocument(db: Database, actor: Actor, id: string) {
  const doc = await getVisibleDocument(db, actor, id);
  const data = await getStorage().get(doc.storageKey);
  await audit(db, actor, {
    action: "document.downloaded",
    entityType: "document",
    entityId: id,
    summary: `Downloaded “${doc.title}”`,
  });
  return { doc, data };
}

export async function updateDocument(db: Database, actor: Actor, id: string, input: Partial<DocumentMeta>) {
  return db.transaction(async (tx) => {
    const before = await getVisibleDocument(tx, actor, id);
    if (!canEdit(actor, before))
      throw forbidden("Only the uploader or a document manager can change this document.");
    await validateMeta(tx, actor, input);
    const patch = { ...input, ...(input.expiresOn !== undefined ? { expiryNotifiedAt: null } : {}) };
    const [after] = await tx
      .update(documents)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(documents.orgId, actor.orgId), eq(documents.id, id)))
      .returning({ id: documents.id, title: documents.title });
    await audit(tx, actor, {
      action: "document.updated",
      entityType: "document",
      entityId: id,
      summary: `Updated “${after!.title}”`,
      metadata: diff(before as unknown as Record<string, unknown>, input as Record<string, unknown>),
    });
    return after!;
  });
}

export async function deleteDocument(db: Database, actor: Actor, id: string) {
  const storageKey = await db.transaction(async (tx) => {
    const doc = await getVisibleDocument(tx, actor, id);
    if (!canEdit(actor, doc))
      throw forbidden("Only the uploader or a document manager can delete this document.");
    await tx.delete(documents).where(and(eq(documents.orgId, actor.orgId), eq(documents.id, id)));
    await audit(tx, actor, {
      action: "document.deleted",
      entityType: "document",
      entityId: id,
      summary: `Deleted “${doc.title}”`,
      metadata: { fileName: doc.fileName, sha256: doc.sha256 },
    });
    return doc.storageKey;
  });
  // Bytes are removed only after the record deletion committed.
  await getStorage().delete(storageKey);
  return { ok: true };
}

/** Documents needing attention: expired or expiring within 30 days, visible to the actor. */
export async function expiringDocuments(db: Database, actor: Actor, limit = 6) {
  if (!can(actor, "document:read")) return [];
  return baseQuery(db)
    .where(
      and(
        eq(documents.orgId, actor.orgId),
        visibleTo(actor),
        isNotNull(documents.expiresOn),
        lte(documents.expiresOn, addDaysISO(todayISO(), 30)),
      ),
    )
    .orderBy(asc(documents.expiresOn))
    .limit(limit);
}

/**
 * Worker job: notify once when a document enters its expiry warning window.
 * Recipients are the uploader and the employee it concerns (if they have an
 * account). The conditional update makes it safe to run concurrently.
 */
export async function notifyExpiringDocuments(db: Database) {
  const horizon = addDaysISO(todayISO(), EXPIRY_WARNING_DAYS);
  return db.transaction(async (tx) => {
    const due = await tx
      .update(documents)
      .set({ expiryNotifiedAt: new Date() })
      .where(
        and(
          isNull(documents.expiryNotifiedAt),
          isNotNull(documents.expiresOn),
          lte(documents.expiresOn, horizon),
        ),
      )
      .returning({
        id: documents.id,
        orgId: documents.orgId,
        title: documents.title,
        expiresOn: documents.expiresOn,
        uploadedByUserId: documents.uploadedByUserId,
        employeeId: documents.employeeId,
      });
    for (const d of due) {
      const recipients = new Set<string>();
      if (d.uploadedByUserId) recipients.add(d.uploadedByUserId);
      if (d.employeeId) {
        const [e] = await tx
          .select({ userId: employees.userId })
          .from(employees)
          .where(and(eq(employees.orgId, d.orgId), eq(employees.id, d.employeeId)));
        if (e?.userId) recipients.add(e.userId);
      }
      const expired = d.expiresOn! < todayISO();
      for (const userId of recipients) {
        await notify(tx, {
          orgId: d.orgId,
          userId,
          actorUserId: null,
          type: "DOCUMENT_EXPIRING",
          title: expired ? `“${d.title}” has expired` : `“${d.title}” expires on ${d.expiresOn}`,
          link: "/documents?expiring=1",
        });
      }
    }
    return due.length;
  });
}
