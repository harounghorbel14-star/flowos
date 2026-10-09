# Running and deploying FLOWOS

FLOWOS has **not been deployed anywhere** by this work. This document describes
how to run it locally and what a production deployment needs.

## Requirements

- Node.js ≥ 22
- PostgreSQL ≥ 15 (column-list `ON DELETE SET NULL` is used); developed on 16

## Local development

```bash
npm install
cp .env.example .env            # adjust DATABASE_URL if needed
createdb flowos                 # or use your own database
npm run db:migrate              # apply migrations (explicit step)
npm run dev                     # API on :3000, Vite on :5173 (proxies /api)
```

Open http://localhost:5173, create an account, then an organization.

## Quality gates

```bash
npm run check        # prettier --check, eslint, tsc, vitest, production build
npm test             # integration tests only
npm run test:e2e     # browser smoke test against a running app (see below)
npm run test:live    # assistant against the real Anthropic API (needs ANTHROPIC_API_KEY)
```

Integration tests need a disposable database whose name contains `test`
(default `postgres://flowos:flowos@localhost:5432/flowos_test`, override with
`TEST_DATABASE_URL`). **The test setup drops and recreates its schema.**

The E2E test drives Chromium through a two-user scenario. Start the app first
(`npm run dev`, or `npm start` and set `E2E_BASE_URL=http://localhost:3000`).
It needs Playwright's Chromium (`npx playwright install chromium` on a fresh
machine). Each run creates two accounts, so the signup rate limit allows at most
two runs per minute per IP.

### Assistant UI test (no API key needed)

```bash
npm run e2e:ai-harness          # real server + DB on :3200 with a scripted test provider
npm run test:e2e:assistant      # in another terminal
```

The harness is test-only code in `e2e/`; it is not part of the build.

## Configuration

| Variable                                     | Required       | Default                 | Purpose                                                                                                                                                                                            |
| -------------------------------------------- | -------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                               | yes            | —                       | PostgreSQL connection string                                                                                                                                                                       |
| `APP_ORIGIN`                                 | yes in prod    | `http://localhost:5173` | Public origin; mutations from other origins are rejected. The server refuses to start in production without it                                                                                     |
| `NODE_ENV`                                   |                | `development`           | `production` enables secure cookies, masked errors, static client serving                                                                                                                          |
| `PORT`                                       |                | `3000`                  | HTTP port                                                                                                                                                                                          |
| `TRUST_PROXY`                                | behind a proxy | `0`                     | Number of reverse-proxy hops to trust for client IPs. Leaving it 0 behind a load balancer makes every client share one rate-limit bucket (logged as a warning at startup)                          |
| `STORAGE_DIR`                                |                | `./storage`             | Private document storage directory (must not be web-served; back it up)                                                                                                                            |
| `FLOWOS_MIGRATE_ON_START`                    |                | `false`                 | Apply migrations at boot — only for single-instance setups                                                                                                                                         |
| `FLOWOS_WORKER`                              |                | `true`                  | Run the workflow/expiry worker in this process                                                                                                                                                     |
| `ANTHROPIC_API_KEY`                          |                | —                       | Enables the AI assistant (server-side only). Unset: assistant shows "not configured"                                                                                                               |
| `INTEGRATIONS_ENCRYPTION_KEY`                |                | —                       | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts integration secrets at rest. Unset: integrations cannot be connected. Losing it makes stored connections unreadable (reconnect them) |
| `STRIPE_SECRET_KEY`                          | for billing    | —                       | Enables billing together with the next three. All unset: self-hosted mode, no plan limits                                                                                                          |
| `STRIPE_WEBHOOK_SECRET`                      | for billing    | —                       | Signing secret of the webhook endpoint (`whsec_…`)                                                                                                                                                 |
| `STRIPE_PRICE_TEAM`, `STRIPE_PRICE_BUSINESS` | for billing    | —                       | Stripe Price ids for the paid plans (at least one)                                                                                                                                                 |

## Production build

```bash
npm ci
npm run build                 # dist/client (static) + dist/server/index.js
npm run db:migrate            # with production DATABASE_URL
NODE_ENV=production APP_ORIGIN=https://app.example.com npm start
```

The server serves the built client and the API from one origin. The server
never migrates at boot unless `FLOWOS_MIGRATE_ON_START=true`. Verified
locally from a clean checkout, the way CI runs it: `npm ci`, `npm run build`,
`npm run db:migrate`, then `NODE_ENV=production node dist/server/index.js`.
The 25-step browser E2E passes, the onboarding workflow run completes in the
background worker, and the server log contains only its startup line.
`server/test/boot.test.ts` checks the same boot path in `npm test`.

## Configuring the Anthropic API key

The assistant reads `ANTHROPIC_API_KEY` from the server's environment only.
Never put the key in `.env.example`, in client code, or in any committed file.

- **Local machine:** add `ANTHROPIC_API_KEY=...` to `.env` (git-ignored).
- **Production:** set it in your host's secret manager as an environment variable for the server process.
- **Claude Code cloud environment (to let the agent run live verification):** open the environment menu in the session's title bar, choose Edit, and add `ANTHROPIC_API_KEY` as an environment variable or secret. A new session picks it up. Do not paste the key into the chat.

Then verify against the live API (a handful of model requests):

```bash
npm run test:live    # fails immediately with instructions if ANTHROPIC_API_KEY is unset
```

`server/test-live/assistant.live.test.ts` checks four things against the
real model: an answer grounded in a permitted read tool, `create_task`
prepared but not executed until the confirmation call (a chat "yes" does not
count), a viewer never offered write tools, and no data from another
organization in tool results or answers.

## Operations

- **Health:** `GET /api/health` is liveness (the process serves HTTP). `GET /api/ready` is readiness: 200 when the database answers within 2 s, 503 otherwise and while shutting down. Route load-balancer traffic on `/api/ready`.
- **Shutdown:** on `SIGTERM`/`SIGINT` the server marks itself not ready, stops accepting connections, lets in-flight requests and the current worker tick finish, closes the database pool and exits 0; it force-exits after 10 s. Long assistant streams may be cut by that limit.
- **Database outages:** idle connections lost to a Postgres restart are replaced (the process no longer crashes). Connections time out after 5 s; statements after 30 s; idle transactions after 60 s. The worker backs off exponentially (up to 60 s) while the database is unreachable and logs when it recovers.
- **Startup failures** (invalid configuration, port in use) exit with code 1 so a supervisor restarts or alerts.
- **Worker:** workflow ticks every 2 s; housekeeping (document expiry reminders, purging expired rate-limit windows and sessions) once a minute. A run whose process died on its final attempt is marked failed and its owner notified.
- **Static files:** hashed assets are served `immutable` for a year; `index.html` is `no-cache`; no source maps are published.
- **Logs** go to stdout/stderr as plain text. Database errors are logged as SQLSTATE plus table/constraint only, never with query values.

### Recovery procedures

- _Database restored from backup:_ run `npm run db:migrate` (idempotent), then start the app. Document files in `STORAGE_DIR` must come from a backup taken at the same time; a record whose file is missing returns an error on download.
- _Stuck workflow runs:_ runs left `RUNNING` by a dead process are re-claimed after their 5-minute lock expires, or failed if it was their last attempt. Failed runs can be retried from the workflow page.
- _Assistant conversation stuck "answering":_ its lock expires after 3 minutes without renewal.

## Billing (Stripe)

1. In Stripe (test mode first), create a Product with a recurring Price for each paid plan and note the Price ids.
2. Add a webhook endpoint `https://<APP_ORIGIN>/api/billing/stripe/webhook` listening to `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`; copy its signing secret.
3. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_TEAM`/`STRIPE_PRICE_BUSINESS`, run `npm run db:migrate`, restart.
4. Verify: as an owner, Settings → Billing → choose a plan, pay with a Stripe test card, and check the plan changes after the webhook arrives (Stripe dashboard → webhook deliveries should show 200).
5. Enable the Customer Portal in Stripe settings for "Manage billing".

Feature flags (operator only): `npm run flags -- set <orgId> assistant on "beta"`, `list`, `clear`.

## Integrations (Slack, Microsoft Teams)

Set `INTEGRATIONS_ENCRYPTION_KEY` (keep it in the secret store and back it up). Admins connect a channel in Settings → Integrations with the provider's incoming-webhook URL and use "Send test message" to verify. Messages are sent by workflows with the "Post a message to Slack or Teams" action; delivery is at least once (a crash between sending and recording can repeat a message). Only `hooks.slack.com` and Microsoft webhook hosts are accepted.

## Rotating the Anthropic API key

1. In the Anthropic Console, create a new key.
2. Update `ANTHROPIC_API_KEY` in the secret store (or `.env`) of every server instance and restart them; the key is read at startup.
3. Verify: `npm run test:live` against a test database, or ask the assistant a question in the app.
4. Revoke the old key in the Console.

A leaked key (including the one committed in `76ad080`, see SECURITY.md) must be revoked immediately, before rotation is complete.

### Checklist for a real deployment

- [ ] Terminate TLS in front of the app (cookies are `Secure` in production) and set `TRUST_PROXY` accordingly.
- [ ] Point load-balancer health checks at `/api/ready`; allow ≥10 s for graceful shutdown.
- [ ] Use a managed PostgreSQL with backups and point-in-time recovery.
- [ ] Mount `STORAGE_DIR` on persistent, backed-up, non-public storage — or implement an S3-compatible `StorageAdapter` (not implemented yet).
- [ ] Run exactly the replicas you need with `FLOWOS_WORKER=true` on at least one (multiple are safe).
- [ ] Run `npm run db:migrate` as a release step, not at boot, when running multiple instances.
- [ ] Configure log shipping (the server logs to stdout/stderr).
- [ ] Review [SECURITY.md](SECURITY.md) "Known gaps".

**Not verified:** no real deployment exists. Everything above was verified locally and in CI (production build started with `node`, fresh database), not on a hosting platform.

CI: `.github/workflows/ci.yml` runs `npm run check` against a Postgres 16 service and the browser E2E against the production build on every pull request and push to `main`. No container image or infrastructure-as-code exists yet.
