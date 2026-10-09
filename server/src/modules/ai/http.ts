import express, { type NextFunction, type Request, type Response, Router } from "express";
import { z } from "zod";
import { SESSION_COOKIE, validateSession } from "../../auth/session";
import { getDb } from "../../db/client";
import { AppError } from "../../lib/errors";
import { loadActor } from "../../lib/membership";
import { runTurn, type TurnEvent } from "./assistant";

const body = z.object({ text: z.string().trim().min(1).max(4000) });

const STATUS: Record<AppError["code"], number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TOO_MANY_REQUESTS: 429,
};

/**
 * POST /api/ai/conversations/:id/messages — streams the turn as NDJSON
 * (one TurnEvent per line) so text appears as it is generated.
 */
export function aiHttpRouter(csrfGuard: (req: Request, res: Response, next: NextFunction) => void) {
  const r = Router();
  r.post("/conversations/:id/messages", csrfGuard, express.json({ limit: "16kb" }), (req, res, next) => {
    (async () => {
      const db = getDb();
      const auth = await validateSession(
        db,
        (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE],
      );
      if (!auth) throw new AppError("UNAUTHORIZED", "Please sign in.");
      const { actor } = await loadActor(db, auth.user.id, req.header("x-flowos-org"), req.ip ?? null);
      if (!actor) throw new AppError("FORBIDDEN", "You are not a member of this organization.");
      const id = String(req.params.id);
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError("NOT_FOUND", "Conversation not found.");
      const parsed = body.safeParse(req.body);
      if (!parsed.success) throw new AppError("BAD_REQUEST", "Write a message of up to 4000 characters.");

      let started = false;
      const emit = (event: TurnEvent) => {
        if (!started) {
          res.status(200).setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("X-Accel-Buffering", "no");
          started = true;
        }
        res.write(`${JSON.stringify(event)}\n`);
      };
      try {
        await runTurn(db, actor, id, parsed.data.text, emit);
      } catch (err) {
        if (!started) throw err;
        emit({ type: "error", message: err instanceof AppError ? err.message : "The assistant failed." });
      }
      if (!started) emit({ type: "done", stopReason: null });
      res.end();
    })().catch((err: unknown) => {
      if (err instanceof AppError) {
        res.status(STATUS[err.code]).json({ error: err.message });
        return;
      }
      next(err);
    });
  });
  return r;
}
