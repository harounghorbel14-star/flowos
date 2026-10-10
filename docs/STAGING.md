# Staging deployment

**Status: not deployed.** Nothing in this document has been run against a
hosting provider. The container image and the release steps below were
verified locally (Docker + PostgreSQL 16: migrate, seed, start, readiness,
the 29-step browser E2E, uploads on the volume, graceful stop) and are built
and started in CI on every pull request.

## What staging needs (from the code)

| Need                                              | Why                                                                                                        | Where in the code                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| One container running `node dist/server/index.js` | serves the API, the built client and the background worker in one process                                  | `server/src/index.ts`, `Dockerfile` |
| PostgreSQL ≥ 15 (16 recommended)                  | all data; column-list `ON DELETE SET NULL` needs 15+                                                       | `drizzle/*.sql`                     |
| A **persistent disk** mounted at `/data`          | uploaded documents are stored on local disk (`STORAGE_DIR=/data/storage`); there is no S3 adapter yet      | `server/src/storage/storage.ts`     |
| **Exactly one instance**                          | local-disk storage is not shared between instances (the worker itself is safe to run on several)           | —                                   |
| A release step before each new version            | migrations are never applied at boot                                                                       | `dist/server/migrate.js`            |
| Health checks on `/api/ready`                     | 200 when the database answers, 503 when it does not or while shutting down; `/api/health` is liveness only | `server/src/app.ts`                 |
| ≥ 10 s for shutdown                               | the server drains requests and the worker on `SIGTERM`                                                     | `server/src/index.ts`               |
| HTTPS in front                                    | cookies are `Secure` in production                                                                         | —                                   |

## Recommended platform: Render

Render fits the shape above with the least setup: it deploys straight from
the repository's `Dockerfile`, offers managed PostgreSQL, attachable
persistent disks, a health-check path and a pre-deploy command for
migrations. Persistent disks require a paid instance type and limit the
service to one instance; check current pricing before creating anything.
**Do not create these resources until you approve the cost.**

Alternative with the same shape: **Fly.io** (Dockerfile, a volume mounted at
`/data`, `release_command = "node dist/server/migrate.js"` in `fly.toml`,
and a managed or external PostgreSQL). Any host works if it can run one
container with a persistent volume and a release command.

### Steps on Render (once approved)

1. **Database** — New → PostgreSQL (version 16), in the same region you will
   use for the app. Copy its _Internal Database URL_ from the database page
   (you will paste it into Render's environment settings, not anywhere else).
2. **Web service** — New → Web Service → connect `harounghorbel14-star/follow`,
   branch to deploy (e.g. `main` after the PRs are merged), runtime
   **Docker** (it finds the `Dockerfile`). Instance type: one with persistent
   disk support; instances: **1**.
3. **Disk** — add a persistent disk mounted at **`/data`** (1 GB is plenty for
   staging).
4. **Health check path** — `/api/ready`.
5. **Pre-deploy command** — `node dist/server/migrate.js`.
6. **Environment** — add the variables below in the service's _Environment_
   tab. Secrets are entered there only: never in chat, Git, `.env.example`,
   source files or any `VITE_*`/client variable.
7. Deploy. Then (optional, staging only) load demo data once from the
   service's _Shell_:
   `FLOWOS_ALLOW_DEMO_SEED=true FLOWOS_DEMO_PASSWORD='<a private passphrase, 16+ characters>' node dist/server/seed.js`.
   In production mode the seed refuses to run without that flag and a
   private password of at least 16 characters; it rejects the documented
   local demo password and never prints the one you chose. Share the
   passphrase with testers privately (password manager), and never seed a
   database that real users will use.

### Environment variables

| Variable                                                                                   | Required          | Value for staging                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                             | **yes**           | the Render Internal Database URL (secret)                                                                                                                                                                                 |
| `APP_ORIGIN`                                                                               | **yes**           | the public URL, e.g. `https://flowos-staging.onrender.com` (the server refuses to start without it)                                                                                                                       |
| `TRUST_PROXY`                                                                              | **yes on Render** | `1` (one proxy in front); check that sign-in audit entries show real client IPs, adjust if not                                                                                                                            |
| `NODE_ENV`, `PORT`, `STORAGE_DIR`                                                          | set by the image  | `production`, `3000`, `/data/storage` — leave as is unless the platform injects `PORT`                                                                                                                                    |
| `INTEGRATIONS_ENCRYPTION_KEY`                                                              | optional          | `openssl rand -base64 32`, generated on your machine and pasted only into the platform (secret). Without it Slack/Teams cannot be connected. Keep a copy in a password manager: losing it means reconnecting integrations |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_TEAM`, `STRIPE_PRICE_BUSINESS` | optional          | **test-mode** values only for staging (`sk_test_…`). Unset = self-hosted mode (no limits). Webhook endpoint: `https://<APP_ORIGIN host>/api/billing/stripe/webhook` (see DEPLOYMENT.md → Billing)                         |
| `ANTHROPIC_API_KEY`                                                                        | optional          | leave **unset** until you decide to enable paid assistant usage; never reuse the key leaked in `76ad080`                                                                                                                  |
| `FLOWOS_WORKER`                                                                            | optional          | `true` (default)                                                                                                                                                                                                          |
| `FLOWOS_MIGRATE_ON_START`                                                                  | no                | leave unset; the pre-deploy command migrates                                                                                                                                                                              |

### Migrations safely

- Migrations only add (tables, columns, indexes, enum values); 0009 also
  revokes duplicate open invitations. They run in the pre-deploy step; if
  one fails, the deploy stops and the previous version keeps serving.
- Before migrating a database with data you care about, take a backup
  (Render: database → _Backups_, or `pg_dump`).
- Upgrading a database created from `main` (9 migrations) to this branch
  (14) was tested locally with data present.

## Staging smoke test (after each deploy)

1. `https://<staging>/api/ready` → `{"ok":true}`.
2. Open the URL, create an account (or sign in with a demo user if seeded).
3. Create an organization, a task, and complete it.
4. Settings → Members → invite a second email; open the invitation link in a
   private window, sign up, accept.
5. Workflows → **Start from the onboarding template** → People → **Add
   employee** (status Active, choose a Manager) → within a few seconds two
   tasks appear and the run shows _Succeeded_ (the steps are in
   [WEB_TESTING_GUIDE.md](WEB_TESTING_GUIDE.md), section 7).
6. Documents → upload a small PDF, download it, then **restart the service**
   and download it again (proves the disk persists).
7. Settings → Billing shows the plan; Settings → Integrations shows whether
   the encryption key is configured.
8. Check the service logs: a `FLOWOS API listening` line, no repeated
   `worker tick failed`.
9. Mobile check: open the URL on a phone; the navigation drawer opens and
   pages do not scroll sideways.

Only after all nine pass, and the URL has actually been opened, may the
staging environment be reported as working.

## Rollback

- **Code:** redeploy the previous successful deploy (Render: _Deploys_ → the
  previous one → _Rollback_). The schema stays at the newer version; all
  migrations so far are additive, so the previous code runs on it.
- **Bad data or a failed migration on staging:** restore the database
  backup taken before the deploy, then redeploy the matching version.
- **Disk:** the `/data` disk is not rolled back with code; restoring
  documents requires a disk snapshot (keep them in step with database
  backups).

## Building and running the image yourself

```bash
docker build -t flowos .
# Behind Docker Hub rate limits: --build-arg NODE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim
docker run --rm -e DATABASE_URL=postgres://… flowos node dist/server/migrate.js
docker run -d --name flowos -p 3000:3000 -v flowos-data:/data \
  -e DATABASE_URL=postgres://… -e APP_ORIGIN=http://localhost:3000 flowos
curl http://localhost:3000/api/ready
```

On Linux, reach a PostgreSQL running on the host with `--network host` and
`127.0.0.1` in `DATABASE_URL`.
