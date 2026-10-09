import path from "node:path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { env, isProduction } from "./env";
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
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
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
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  if (isProduction()) {
    const clientDir = path.resolve(process.cwd(), "dist/client");
    app.use(express.static(clientDir, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(clientDir, "index.html"));
    });
  }
  return app;
}
