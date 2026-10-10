import express, { type NextFunction, type Request, type Response, Router } from "express";
import { SESSION_COOKIE, validateSession } from "../../auth/session";
import { getDb } from "../../db/client";
import { RateLimiter } from "../../auth/rateLimit";
import { assertCan, type Actor } from "../../lib/actor";
import { AppError } from "../../lib/errors";
import { loadActor } from "../../lib/membership";
import { documentMeta } from "./schemas";
import { downloadDocument, MAX_DOCUMENT_BYTES, uploadDocument } from "./service";

const STATUS: Record<AppError["code"], number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TOO_MANY_REQUESTS: 429,
};

/** Resolve session + membership exactly like orgProcedure does for tRPC. */
async function requireActor(req: Request, orgId: string | undefined) {
  const db = getDb();
  const auth = await validateSession(db, (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE]);
  if (!auth) throw new AppError("UNAUTHORIZED", "Please sign in.");
  const { actor } = await loadActor(db, auth.user.id, orgId, req.ip ?? null);
  if (!actor) throw new AppError("FORBIDDEN", "You are not a member of this organization.");
  return actor;
}

/** Wrap an async handler; with `chain`, a successful run continues to the next middleware. */
function handle(fn: (req: Request, res: Response) => Promise<void>, chain = false) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res)
      .then(() => {
        if (chain) next();
      })
      .catch((err: unknown) => {
        if (err instanceof AppError) {
          // The request body may not have been read; do not keep the connection for it.
          if (chain) res.setHeader("Connection", "close");
          res.status(STATUS[err.code]).json({ error: err.message });
          return;
        }
        next(err);
      });
  };
}

/** Uploads per user per minute (shared across instances). */
export const uploadLimiter = new RateLimiter("upload", 30, 60_000);

/** RFC 6266 filename parameter, ASCII fallback plus UTF-8 form. */
function contentDisposition(fileName: string) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function documentsHttpRouter(csrfGuard: (req: Request, res: Response, next: NextFunction) => void) {
  const r = Router();

  // Upload: raw bytes in the body, metadata as URI-encoded JSON in a header.
  // The session, membership, permission and rate limit are checked BEFORE the body is read,
  // so unauthenticated or throttled clients cannot make the server buffer 10 MB each.
  r.post(
    "/upload",
    csrfGuard,
    handle(async (req, res) => {
      const actor = await requireActor(req, req.header("x-flowos-org"));
      assertCan(actor, "document:upload");
      await uploadLimiter.consume(`user:${actor.userId}`, getDb());
      res.locals.actor = actor;
    }, true),
    express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES }),
    handle(async (req, res) => {
      const actor = res.locals.actor as Actor;
      let metaRaw: unknown;
      try {
        metaRaw = JSON.parse(decodeURIComponent(req.header("x-flowos-meta") ?? "{}"));
      } catch {
        throw new AppError("BAD_REQUEST", "Invalid document details.");
      }
      const parsed = documentMeta.extend({ fileName: documentMeta.shape.title }).safeParse(metaRaw);
      if (!parsed.success)
        throw new AppError("BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid document details.");
      const { fileName, ...meta } = parsed.data;
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const doc = await uploadDocument(getDb(), actor, meta, fileName, body);
      res.status(201).json(doc);
    }),
  );

  // Download: browser navigation, so the org comes from the query string; membership is re-verified.
  r.get(
    "/:id/download",
    handle(async (req, res) => {
      const actor = await requireActor(req, typeof req.query.org === "string" ? req.query.org : undefined);
      const id = String(req.params.id);
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError("NOT_FOUND", "Document not found.");
      const { doc, data } = await downloadDocument(getDb(), actor, id);
      res.setHeader("Content-Type", doc.mimeType);
      res.setHeader("Content-Length", String(data.length));
      res.setHeader("Content-Disposition", contentDisposition(doc.fileName));
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.end(data);
    }),
  );

  // Payload too large and other body-parser errors.
  r.use((err: { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (err.type === "entity.too.large") {
      res.status(413).json({ error: "Files can be at most 10 MB." });
      return;
    }
    next(err);
  });
  return r;
}
