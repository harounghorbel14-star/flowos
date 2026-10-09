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

| Variable                  | Required    | Default                 | Purpose                                                                              |
| ------------------------- | ----------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `DATABASE_URL`            | yes         | —                       | PostgreSQL connection string                                                         |
| `APP_ORIGIN`              | yes in prod | `http://localhost:5173` | Public origin; mutations from other origins are rejected                             |
| `NODE_ENV`                |             | `development`           | `production` enables secure cookies, masked errors, static client serving            |
| `PORT`                    |             | `3000`                  | HTTP port                                                                            |
| `TRUST_PROXY`             |             | `0`                     | Number of reverse-proxy hops to trust for client IPs (rate limiting, audit)          |
| `STORAGE_DIR`             |             | `./storage`             | Private document storage directory (must not be web-served; back it up)              |
| `FLOWOS_MIGRATE_ON_START` |             | `false`                 | Apply migrations at boot — only for single-instance setups                           |
| `FLOWOS_WORKER`           |             | `true`                  | Run the workflow/expiry worker in this process                                       |
| `ANTHROPIC_API_KEY`       |             | —                       | Enables the AI assistant (server-side only). Unset: assistant shows "not configured" |

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

### Checklist for a real deployment

- [ ] Terminate TLS in front of the app (cookies are `Secure` in production) and set `TRUST_PROXY` accordingly.
- [ ] Use a managed PostgreSQL with backups and point-in-time recovery.
- [ ] Mount `STORAGE_DIR` on persistent, backed-up, non-public storage — or implement an S3-compatible `StorageAdapter` (not implemented yet).
- [ ] Run exactly the replicas you need with `FLOWOS_WORKER=true` on at least one (multiple are safe).
- [ ] Run `npm run db:migrate` as a release step, not at boot, when running multiple instances.
- [ ] Configure log shipping (the server logs to stdout/stderr).
- [ ] Review [SECURITY.md](SECURITY.md) "Known gaps".

CI: `.github/workflows/ci.yml` runs `npm run check` against a Postgres 16 service and the browser E2E against the production build on every pull request and push to `main`. No container image or infrastructure-as-code exists yet.
