import path from "node:path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { sql } from "drizzle-orm";
import { getDb } from "./db/client";
import { env, isProduction } from "./env";
import { aiHttpRouter } from "./modules/ai/http";
import { documentsHttpRouter } from "./modules/documents/http";
import { createContext } from "./trpc/context";
import { appRouter } from "./trpc/router";

/**
 * CSRF defence for the API. The session cookie is SameSite=Lax; in addition
 * every state-changing request must (a) carry the custom header that only our
 * client sets — browsers cannot add it cross-origin without a CORS preflight,
 * which we never grant — and (b) if an Origin header is present, match ours.
 */
export function csrfGuard(req: Request, res: Response, next: NextFunction) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (req.header("x-flowos-client") !== "web") {
    res.status(403).json({ error: "Missing client header." });
    return;
  }
  const origin = req.header("origin");
  if (origin && origin !== env().APP_ORIGIN && !(env().NODE_ENV !== "production" && isLocalhost(origin))) {
    res.status(403).json({ error: "Cross-origin request rejected." });
    return;
  }
  next();
}

function isLocalhost(origin: string) {
  try {
    return ["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

let draining = false;
/** Called on shutdown so load balancers stop routing here before connections close. */
export function markDraining() {
  draining = true;
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  if (env().TRUST_PROXY > 0) app.set("trust proxy", env().TRUST_PROXY);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'"],
          "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          "font-src": ["'self'", "https://fonts.gstatic.com"],
          "img-src": ["'self'", "data:"],
          "connect-src": ["'self'"],
          "frame-ancestors": ["'none'"],
        },
      },
    }),
  );
  app.use(cookieParser());
  // Liveness: the process is serving HTTP.
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });
  // Readiness: the database answers within 2 s. Load balancers should route on this.
  app.get("/api/ready", async (_req, res) => {
    if (draining) {
      res.status(503).json({ ok: false, error: "shutting down" });
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        getDb().execute(sql`select 1`),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), 2000);
        }),
      ]);
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false, error: "database unavailable" });
    } finally {
      clearTimeout(timer);
    }
  });
  app.use(
    "/api/trpc",
    express.json({ limit: "1mb" }),
    csrfGuard,
    createExpressMiddleware({
      router: appRouter,
      createContext,
      maxBatchSize: 20,
    }),
  );
  app.use("/api/documents", documentsHttpRouter(csrfGuard));
  app.use("/api/ai", aiHttpRouter(csrfGuard));
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  if (isProduction()) {
    const clientDir = path.resolve(process.cwd(), "dist/client");
    // Vite's assets are content-hashed: cache forever. A missing one is a 404 (not the SPA page),
    // so a tab left open across a deploy fails visibly instead of with a MIME-type error.
    app.use(
      "/assets",
      express.static(path.join(clientDir, "assets"), { index: false, immutable: true, maxAge: "1y" }),
      (_req: Request, res: Response) => {
        res.status(404).end();
      },
    );
    app.use(express.static(clientDir, { index: false, maxAge: "1h" }));
    // The SPA shell must always be revalidated so users pick up new deploys.
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(clientDir, "index.html"));
    });
  }
  return app;
}
