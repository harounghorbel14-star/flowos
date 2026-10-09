# FLOWOS implementation status

Last verified: 2026-10-09 on commit `fea0576` (branch `claude/flowos-phase-jk`). "Locally" means this build container; "CI" means GitHub Actions. Nothing has been deployed: there is no staging or production environment yet.

## Initial audit

At the start of this work the repository (`harounghorbel14-star/follow`)
contained a single commit with an 8-byte `README.md`. There was no code,
schema, documentation or configuration; no other accessible repository
contained FLOWOS. Every feature below was therefore built in this branch, and
the stack choice is explained in [ARCHITECTURE.md](ARCHITECTURE.md).

## Status legend

- **IMPLEMENTED AND VERIFIED** — database, service, API, authorization, UI and tests exist and pass.
- **IMPLEMENTED BUT UNVERIFIED** — code exists but has not been exercised against the real dependency.
- **PARTIALLY IMPLEMENTED** — usable, with listed parts missing.
- **ARCHITECTURE ONLY** — interfaces/extension points exist, no working feature.
- **NOT IMPLEMENTED**.

## Verification summary

| Gate                                                                                  | Command                                                 | Result                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Formatting                                                                            | `npm run format:check`                                  | pass                                                                                                                                                                                                                                                                                                                                                                                       |
| Lint                                                                                  | `npm run lint`                                          | pass (0 warnings)                                                                                                                                                                                                                                                                                                                                                                          |
| Type check                                                                            | `npm run typecheck`                                     | pass                                                                                                                                                                                                                                                                                                                                                                                       |
| Integration tests (real PostgreSQL 16, real migrations)                               | `npm test`                                              | 164 / 164 pass (17 files), locally from a clean checkout and in CI                                                                                                                                                                                                                                                                                                                         |
| Production build                                                                      | `npm run build`                                         | pass                                                                                                                                                                                                                                                                                                                                                                                       |
| Migrations from empty database                                                        | test global setup + `npm run db:migrate`                | pass (14 migrations; 0009 also verified as an upgrade over data)                                                                                                                                                                                                                                                                                                                           |
| Browser E2E (2 users, 29 steps, desktop + mobile + dark)                              | `npm run test:e2e`                                      | 29 / 29 against the production build started as CI does, with and without the integrations key; 0 console errors                                                                                                                                                                                                                                                                           |
| Production boot (bundle + `node`, `NODE_ENV=production`)                              | `server/test/boot.test.ts`                              | pass: no boot migration, worker runs workflows, survives DB connection loss, ready/503, SIGTERM exits 0, port clash exits 1, prod refuses missing APP_ORIGIN                                                                                                                                                                                                                               |
| CI (GitHub Actions: check gate, browser E2E on the production build, container image) | `.github/workflows/ci.yml`                              | all three jobs green on `fea0576` (PR #5); PR #4 green on `aff7491`                                                                                                                                                                                                                                                                                                                        |
| Assistant UI E2E (scripted test provider, real server + DB)                           | `npm run e2e:ai-harness` + `npm run test:e2e:assistant` | pass (5 steps)                                                                                                                                                                                                                                                                                                                                                                             |
| Container image                                                                       | `Dockerfile` (`docker build`)                           | locally from a clean checkout of `fea0576`: built; migrate + server in the container; `/api/ready` 200; healthcheck healthy; browser E2E 29 / 29 against the container; uploads on the `/data` volume; `docker stop` → clean shutdown, exit 0; image holds no secrets, `.env`, proxy settings or certificates and runs as `node`. CI job builds it and checks migrate → ready → clean stop |
| Demo seed                                                                             | `npm run db:seed`                                       | creates 2 orgs / 6 users via the API; idempotent; refused with `NODE_ENV=production` unless `FLOWOS_ALLOW_DEMO_SEED=true` **and** a private 16+ character `FLOWOS_DEMO_PASSWORD` (documented demo password rejected, chosen password never printed) — unit tests + manual runs                                                                                                             |
| Local development                                                                     | `npm run dev`                                           | UI at http://localhost:5173 (Vite, proxies `/api` to the API on :3000); seeded owner signs in; Ctrl+C stops both                                                                                                                                                                                                                                                                           |
| Staging deployment                                                                    | `docs/STAGING.md`                                       | **NOT DEPLOYED** — instructions only                                                                                                                                                                                                                                                                                                                                                       |
| Assistant against the live Anthropic API                                              | `npm run test:live`                                     | **PENDING BILLING**: no paid API calls are made; needs a new (non-leaked) `ANTHROPIC_API_KEY` with billing                                                                                                                                                                                                                                                                                 |
| Responsive/visual audit (Playwright)                                                  | scripted, not in the repo                               | 24 routes × 375/820/1440 px × light/dark: no overflow, overlap, console or network errors; plus Settings → Account; Billing, Integrations and Insights (12 weeks) re-checked after Phase J/K                                                                                                                                                                                               |

## Features

### Phase A — Foundation: IMPLEMENTED AND VERIFIED

| Area                                | Status                   | Notes                                                                     |
| ----------------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| Sign up / sign in / sign out        | IMPLEMENTED AND VERIFIED | scrypt, server sessions, rate limits                                      |
| Organizations, onboarding           | IMPLEMENTED AND VERIFIED | creator becomes OWNER; optional directory profile                         |
| Memberships, roles, permissions     | IMPLEMENTED AND VERIFIED | 5 roles, rank rules, last-owner guard                                     |
| Invitations                         | IMPLEMENTED AND VERIFIED | single-use, email-bound, 7-day expiry, link shared manually (no email)    |
| Organization switching              | IMPLEMENTED AND VERIFIED | server re-verifies membership per request; client cache cleared on switch |
| Audit log                           | IMPLEMENTED AND VERIFIED | append-only via DB triggers; read-only API; UI for admins                 |
| App shell, settings, error handling | IMPLEMENTED AND VERIFIED |                                                                           |

- Files: `server/src/{auth,trpc,lib}`, `modules/{auth,orgs,audit}`, `client/src/pages/{Auth,Onboarding,Settings}.tsx`, `components/Shell.tsx`
- DB: `users`, `sessions`, `organizations`, `memberships`, `invitations`, `audit_events` (+ triggers)
- Tests: `foundation.test.ts` (17), `http.test.ts` (5)
- Known limitations: no password reset, email verification, MFA/SSO, session management UI.

### Phase B — Employees and HR: IMPLEMENTED AND VERIFIED

Directory with search, department/status/manager filters, sorting and
pagination; profiles with reporting line, direct reports, task stats, documents
and audit history; departments with headcount; employment status and dates;
linking a directory profile to a member account (automatic on invite
acceptance when emails match). Reporting cycles and cross-org references are
rejected (also at the database level).

- Files: `modules/{employees,departments}`, `pages/{People,EmployeeDetail,Departments}.tsx`
- Tests: `people.test.ts` (9)
- Not implemented: employee deletion (use status `TERMINATED`), custom fields, bulk import, org chart view.

### Phase C — Tasks and projects: IMPLEMENTED AND VERIFIED

Projects: CRUD, status, owner, members, dates, completion timestamps, status
board of tasks, progress from real task rows, explicit risk reasons, history.
Tasks: CRUD, per-org keys (`ABC-12`), statuses TODO/IN_PROGRESS/BLOCKED/REVIEW/DONE,
priorities LOW–URGENT, assignee, project, due dates, search (title or key),
filters (mine, overdue, unassigned, status, priority, project), sorting,
pagination, comments, activity history, assignment and comment notifications.
`completed_at` is kept consistent with status (and enforced by a CHECK).

- Files: `modules/{projects,tasks}`, `pages/{Projects,ProjectDetail,Tasks,TaskDetail}.tsx`
- Tests: `work.test.ts` (15) including cross-tenant guessed IDs and concurrent numbering
- Not implemented: task attachments (documents exist separately), drag-and-drop board, subtasks, recurring tasks, time tracking.

### Phase D — Approval engine: IMPLEMENTED AND VERIFIED

Typed requests (leave, HR, document, purchase, general) with validated
payloads; explicit state machine (only PENDING → APPROVED / REJECTED /
CANCELLED); designated approver must hold `approval:decide`; guarded
transitions (concurrent decisions → exactly one wins); rejection requires a
reason; comments; decision trail; audit; notifications. Approved leave appears
on the command center for people managers.

- Files: `modules/approvals`, `pages/{Approvals,ApprovalDetail}.tsx`, `components/forms/ApprovalForm.tsx`
- Tests: `approvals.test.ts` (8)
- Not implemented: multi-step / parallel approval chains, delegation, leave balances.

### Phase E — Workflow engine: IMPLEMENTED AND VERIFIED

WHEN → IF → THEN workflows. Triggers: employee added, task status changed,
approval decided. Conditions: is / is not / contains / is set / is empty on the
trigger's fields. Actions: create task (assignee: none, the employee, their
manager, a fixed employee), in-app notification. Transactional outbox,
idempotent dispatch, step-level exactly-once execution, retries with backoff,
permanent-failure detection, manual retry, loop guard, owner-permission
execution, run history UI, onboarding template, command-center failure count.

- Files: `shared/workflows.ts`, `modules/workflows/{engine,actions,service,router}.ts`, `lib/events.ts`, `pages/Workflows.tsx`, `components/forms/WorkflowForm.tsx`
- DB: `domain_events`, `workflows`, `workflow_runs`, `workflow_run_steps`
- Tests: `workflows.test.ts` (11) — end-to-end onboarding, conditions, concurrent workers, permanent failure, resume-after-retry without repeats, transient backoff with rollback, privilege non-escalation, permissions, tenant isolation, loop guard, task/approval triggers
- Not implemented: scheduled (time-based) triggers, more actions (update records, request approval, email/webhooks), visual branching. The worker is in-process (no separate queue service).

### Phase F — Documents and notifications

| Area                                              | Status                                                                          | Notes                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Document upload / metadata / categories / expiry  | IMPLEMENTED AND VERIFIED                                                        | type detected from bytes; 10 MB                                                              |
| Private storage                                   | IMPLEMENTED AND VERIFIED (local disk)                                           | `StorageAdapter`; S3 adapter **NOT IMPLEMENTED**                                             |
| Visibility (org / restricted) and secure download | IMPLEMENTED AND VERIFIED                                                        | SQL-enforced; audited downloads                                                              |
| Expiry reminders                                  | IMPLEMENTED AND VERIFIED                                                        | once per document, 14 days ahead                                                             |
| In-app notifications (persisted, read/unread)     | IMPLEMENTED AND VERIFIED                                                        | task assigned/commented, approvals, member joined, workflow failed/notify, document expiring |
| Email / push delivery                             | NOT IMPLEMENTED — reason: no provider configured; notifications are in-app only |

- Tests: `documents.test.ts` (7) through the real HTTP stack; notification assertions across other suites
- Not implemented: document versioning, previews, virus scanning, full-text content search.

### Phase G — Command center: IMPLEMENTED AND VERIFIED

Live metrics (my open/overdue tasks, decisions awaiting me, org overdue, projects
at risk), rule-based briefing with links, my work, projects at risk with
reasons, decisions waiting, next-7-days deadlines, people on approved leave
(managers), documents needing attention, workflow failures (workflow readers),
permission-filtered activity feed, getting-started checklist, honest empty
states. No revenue or invented metrics.

- Tests: `insight.test.ts` (6)

### Phase H — AI operations assistant: IMPLEMENTED; live-model verification PENDING BILLING

Everything except a live model call is implemented and tested. **No
`ANTHROPIC_API_KEY` is configured as a secret in the build environment, so no
request has been sent to the Anthropic API.** (A key committed to
`.env.example` on `main` was not used: it is treated as compromised; see
SECURITY.md.) The live suite `npm run test:live` is written and type-checked
and fails fast without a key; it has not passed yet because it has not run. The assistant logic, tools, confirmation flow,
persistence and UI were verified with a deterministic scripted provider (a
test double that calls the real tools against the real database).

| Area                                                                                                                                      | Status                           | Notes                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Provider abstraction (`AiProvider`)                                                                                                       | IMPLEMENTED AND VERIFIED         | server-side only; key never reaches the browser                                                                |
| Anthropic adapter (`claude-opus-5-5`, streaming, adaptive thinking, `effort: medium`, prompt caching, `fallbacks: "default"` on refusals) | IMPLEMENTED BUT UNVERIFIED       | type-checked against `@anthropic-ai/sdk` 0.132.1; needs a key to verify                                        |
| Not-configured state                                                                                                                      | IMPLEMENTED AND VERIFIED         | UI and API say so plainly; no fake answers                                                                     |
| Streaming to the browser (NDJSON over CSRF-guarded POST)                                                                                  | IMPLEMENTED AND VERIFIED         | HTTP test + browser E2E                                                                                        |
| Persistent conversations (private per user, append-only transcript)                                                                       | IMPLEMENTED AND VERIFIED         | DB trigger rejects transcript edits                                                                            |
| Tool registry (name, description, Zod schema, permissions, risk, confirmation policy, audit action)                                       | IMPLEMENTED AND VERIFIED         | 8 read tools, 2 write tools                                                                                    |
| Permission-aware tools                                                                                                                    | IMPLEMENTED AND VERIFIED         | model only sees tools the user's role allows; every tool calls the regular service functions as the user       |
| Prepared actions + confirmation                                                                                                           | IMPLEMENTED AND VERIFIED         | hash-bound, user/org-bound, 10-min expiry, single-use, re-authorized at confirm time; chat text cannot confirm |
| Tool execution history, usage (tokens, cache reads, latency, stop reason, errors)                                                         | IMPLEMENTED AND VERIFIED         | `ai_tool_calls`, `ai_usage`                                                                                    |
| Refusal handling                                                                                                                          | IMPLEMENTED AND VERIFIED (logic) | partial output discarded, never stored or acted on                                                             |
| Rate limiting                                                                                                                             | IMPLEMENTED AND VERIFIED         | 20 turns/min per user (shared, Postgres-backed); one turn at a time per conversation                           |

Tools — read: operational snapshot, search people, get person, list tasks,
get task, list projects, my approvals, search document metadata. Write
(confirmation always): create task, update task status.

- Files: `server/src/modules/ai/{provider,tools,assistant,router,http}.ts`, `client/src/pages/Assistant.tsx`, `e2e/{ai-harness.ts,assistant.mjs}`
- DB: `ai_conversations`, `ai_messages`, `ai_actions`, `ai_tool_calls`, `ai_usage`
- Tests: `ai.test.ts` (15), `ai-http.test.ts` (1). Mutation check: making `create_task` skip confirmation fails 2 tests.
- Live tests (not run, need a key): `server/test-live/assistant.live.test.ts` (4): grounded answer via a permitted tool, confirmation required before mutation, viewer gets no write tools, no cross-organization data.
- Not implemented: retrieval over document contents (RAG), structured-output reports, more write tools (approvals, workflows), per-org AI budgets, conversation export.

### Phase I — Global search: IMPLEMENTED AND VERIFIED

Cmd/Ctrl+K palette across people, departments, projects, tasks (title or key),
approvals (only visible ones) and documents (respecting restricted
visibility); quick navigation and create actions. Prefix-ranked `ILIKE`
queries; no vector search (no concrete need yet).

### Phase J — Company intelligence: IMPLEMENTED AND VERIFIED (measured trends)

Insights page (`/insights`) and assistant tool `get_weekly_trends`, all from
direct aggregates with the definition printed under each figure:

- Last 7 days vs the previous 7 (rolling windows): tasks created, tasks completed, approvals decided.
- 8 ISO weeks of tasks created vs completed (current week marked partial).
- Open overdue tasks at each week end, **reconstructed** from creation, due
  and completion dates (stated in the UI; deleted tasks and later reopenings
  are not reflected).
- Approval turnaround: weekly median hours to decision; pending count and median age (admins only).
- Workflow reliability: weekly runs by outcome and the workflows failing in the last 30 days (workflow readers only).
- Notable changes this week from the audit log (projects, people, departments).

Charts follow a validated palette (teal/orange series checked for lightness,
chroma, colour-vision separation and contrast in light and dark), have
hover/keyboard tooltips and a table view.

- Files: `server/src/modules/insights/{service,router}.ts`, `client/src/pages/Insights.tsx`, `client/src/components/charts.tsx`
- Tests: `insights.test.ts` (5) — weekly counts, overdue reconstruction, rolling windows, turnaround median, permission gating, tenant isolation; E2E step
- Completed in this pass: **measured history** — the worker records open, overdue and blocked tasks and pending approvals per organization hourly (`metric_snapshots`, migration 0010), and each past week's overdue figure is shown as measured when a snapshot exists, reconstructed otherwise (labelled per week); **tasks by department** (assignee's department); **4 / 8 / 12-week ranges**.
- Tests: +3 in `insights.test.ts` (snapshots upsert and measured-over-reconstructed, department breakdown with tenant isolation, ranges); E2E step.
- Not implemented: causal analysis (deliberately), forecasting, arbitrary date ranges, history before snapshots began (reconstructed).

### Phase K — Billing and integrations: PARTIALLY IMPLEMENTED

| Area                                                                    | Status                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Plans, entitlements, usage limits                                       | IMPLEMENTED AND VERIFIED           | Free / Team / Business (`shared/billing.ts`); limits on members (incl. open invitations), workflows, storage, assistant requests per month; enforced in the services. Limits are launch defaults, not validated pricing. Billing off (no `STRIPE_*`) = self-hosted, no limits                                                                                                                                                                                |
| Feature flags                                                           | IMPLEMENTED AND VERIFIED           | per-organization operator overrides (`npm run flags`), not editable by members                                                                                                                                                                                                                                                                                                                                                                               |
| Stripe checkout, customer portal                                        | IMPLEMENTED BUT UNVERIFIED         | code path tested with a test double; **never called against Stripe** (no keys in this environment)                                                                                                                                                                                                                                                                                                                                                           |
| Stripe webhooks (verified, idempotent, state-based)                     | IMPLEMENTED AND VERIFIED (offline) | signature over the raw body (Stripe SDK); event id recorded with its effect; subscription state re-read from Stripe on every event (no ordering issues); duplicate subscriptions never replace/downgrade the active one; price rotation and add-on items; cancellation applies even for unknown prices; `invoice.payment_failed` notifies owners; untrusted org ids rejected. Not yet received from a real Stripe account                                    |
| Slack, Microsoft Teams (incoming webhooks)                              | IMPLEMENTED BUT UNVERIFIED         | connect, AES-256-GCM URL storage bound to org+provider, host allow-list plus DNS-resolution check pinned to the connection (no private/metadata addresses), no redirects, 5 s timeout, 10 connect/test calls per org per minute, test message, workflow action `send_message` (permanent vs retryable, failures shown on the connection). Tested against a local HTTPS server and a recording transport; **not yet posted to a real Slack or Teams channel** |
| Google Workspace, Microsoft 365, HubSpot, QuickBooks, WhatsApp Business | ARCHITECTURE ONLY                  | listed as "Not available yet"; `OAuthIntegration` interface in `modules/integrations/providers.ts`; no OAuth flow, sync or token storage exists                                                                                                                                                                                                                                                                                                              |

- Files: `shared/{billing,integrations}.ts`, `server/src/modules/{billing,integrations}/*`, `server/src/lib/crypto.ts`, `server/src/db/flags-cli.ts`, `client/src/pages/Settings.tsx` (Billing, Integrations)
- DB: migrations 0011 (`subscriptions`, `billing_customers`, `webhook_events`, `feature_flags`), 0012 (`integration_connections`), 0013 (`BILLING_ISSUE` notification type)
- Tests: `billing.test.ts` (15), `integrations.test.ts` (22); browser E2E steps for billing (self-hosted) and connecting Slack
- Security audit of this code (independent review): 4 medium and 8 low findings, all fixed or documented — see SECURITY.md, "Billing and integrations"
- To verify for real: set the `STRIPE_*` variables with test-mode keys, add the webhook endpoint in Stripe, complete a test checkout; connect a real Slack/Teams webhook and send a test message (DEPLOYMENT.md).

### Design and UX: IMPLEMENTED AND VERIFIED (E2E + visual review)

Operational-editorial design system (warm paper/graphite, restrained teal,
Fraunces + IBM Plex), light/dark, reduced motion, responsive layout with a
mobile navigation drawer (focus moves in on open, Escape closes, not focusable
when closed), keyboard-accessible dialogs on native `<dialog>`, command
palette with arrow-key navigation that keeps the selection visible, charts
announced to screen readers, skeletons, empty and error states on every data
panel, confirmations before destructive actions, toasts. Dark-mode destructive
buttons meet 4.5:1 contrast. Checked with a scripted Playwright audit (24
routes × mobile/tablet/desktop × light/dark) after fixing 18 defects it found.
Not done: i18n, a formal WCAG audit with assistive technology, drag-and-drop.

## Known defects

No open code defects known. Open security item: the credential committed in `76ad080` must be revoked by the owner (SECURITY.md, "Incident"). Defects found and fixed during this work:

1. Post-signup redirect raced the auth-route redirect, sending invited users to onboarding instead of back to their invitation (found by E2E).
2. Workflow dispatcher matched events to workflows created after the event (found by integration tests).
3. Migrate-on-start silently applied a superseded draft migration in development; migrations are now an explicit step.
4. Audit summaries showed raw enum values; now human labels.
5. The assistant offered `update_task_status` to read-only viewers (execution would still have been refused by the task service); the tool now requires `task:write_own` (found by tests).
6. Tool-input parse failures from the SDK surface as `AnthropicError`, not `SyntaxError`; the retry path now catches the right class (found by reading the SDK source).
7. A response cut off mid tool call would have left a `tool_use` without a `tool_result`, making the next request invalid; such calls are now recorded as not executed (found in self-review, covered by a test).
8. **Production server broke its own workflow worker.** In the esbuild bundle, the "is this the main module?" check in `db/migrate.ts` was true, so `node dist/server/index.js` ran migrations at every boot and then closed the shared pool. HTTP kept working (it opens a new pool) but the worker failed on every tick, so no workflow ran in production. The CLI entry moved to `db/migrate-cli.ts`. Found by CI's production E2E. Regression test: `boot.test.ts` (fails on the old code with `Cannot use a pool after calling end on the pool`).
9. CI E2E job set `NODE_ENV=production` for `npm ci`, which skipped devDependencies (`vite: not found`). Now set only on the server step.
10. `.gitignore` rule `storage/` also ignored `server/src/storage/`, so a clean checkout of `main` did not build; anchored to `/storage/`.

Found by the stabilization audit (backend security, data/ops and UI audits) and fixed, each with a regression test unless noted:

11. A Postgres restart crashed every replica (no pool `error` handler). Pool now also has connect/statement/idle-transaction timeouts. (`boot.test.ts`)
12. No graceful shutdown: deploys cut requests and worker steps. Now drains HTTP and the worker, then closes the pool. `/api/ready` checks the database. (`boot.test.ts`)
13. A port clash exited 0 (looked like success); `APP_ORIGIN` silently defaulted in production. Both now fail with exit 1. (`boot.test.ts`)
14. Workflow runs abandoned on their last attempt were re-claimed forever; now failed and the owner notified. Failed worker ticks back off. (`workflows.test.ts`)
15. Error logs included every bound query parameter (password hashes, emails). Now SQLSTATE and table only. (`hardening.test.ts`)
16. Impossible dates (2026-02-31) and NUL bytes produced 500s; now 400. (`hardening.test.ts`)
17. Members demoted to viewer could still delete their own tasks and comments. (`hardening.test.ts`)
18. Assistant confirmation cards did not say which task would change. They now name the task, assignee and project, and nothing is prepared for another organization's record. (`ai.test.ts`)
19. The assistant's per-conversation lock could expire mid-turn and be released by the wrong turn, corrupting the transcript; client disconnects kept spending tokens; history grew without bound. (`ai.test.ts`)
20. Sessions renewed forever; no password change or "sign out other devices". Now capped at 90 days, with both features in Settings → Account. (`hardening.test.ts`, browser E2E)
21. Uploads were read (10 MB) before authentication; no upload rate limit. (`documents.test.ts`)
22. Concurrent invitations could leave several valid links (unique index, migration 0009). Concurrent opposite manager changes could form a cycle (advisory lock; the race did not reproduce in tests, fix from code review). (`hardening.test.ts`)
23. Missing indexes for session purge, approval and notification lists, and the expiry scan; housekeeping ran every 2 s across all tenants (now once a minute).
24. Missing assets were answered with the SPA page; hashed assets were cached for only 1 h; source maps were public.
25. UI: 18 defects (long titles overflowing, board badges clipped, mobile drawer keyboard trap, palette selection off-screen, chart label collisions and wrong scale, charts not announced, swallowed form errors, unclear leave-date errors, dark-mode contrast 2.4:1, unannounced tab/unread states, unnamed toggles, grammar, incomplete audit filter, missing error states, lost `?next=`, unconfirmed deletes, shared Retry spinner). Verified by a scripted visual audit and the browser E2E.

Found while preparing local testing and staging, fixed with regression tests:

26. `npm run db:seed` pointed at a file that did not exist; a demo seed now creates two organizations and six users through the API.
27. In production the bundled migration and seed tools refused to run without `APP_ORIGIN`, a web-server-only setting (a staging release step would have failed). The check now runs at server start only (`boot.test.ts`).
28. A staging demo seed would have created accounts with the publicly documented password; production seeding now requires a private 16+ character password (`seed.test.ts`).

Remaining limitations (not defects in implemented scope, documented in SECURITY.md/DEPLOYMENT.md): no email delivery (so no email verification or password reset), no MFA/SSO, no per-device session list, no S3 storage adapter, no container image or real deployment, document files deleted after the database row (a crash in between leaves an orphan file), `domain_events` are never purged, plain-text logs without request IDs, no route-level code splitting (main bundle ≈405 kB, 115 kB gzipped).

## Next recommended phase

1. **Revoke the key committed in `76ad080`**, configure a new one as a secret
   (DEPLOYMENT.md, "Configuring the Anthropic API key") and run
   `npm run test:live`.
2. **Verify Phase K against the real services** in test mode: Stripe checkout,
   portal and webhooks; a real Slack and Teams channel (DEPLOYMENT.md,
   "Billing" and "Integrations"). Review the plan limits before selling.
3. **OAuth integrations** (Google Workspace, Microsoft 365, HubSpot,
   QuickBooks, WhatsApp Business) only with a concrete customer need, each
   with the OAuth flow, token refresh, sync and tests described in
   `modules/integrations/providers.ts`.
4. **Production hardening before real customers**: email delivery
   (invitations, verification, password reset), an S3-compatible
   `StorageAdapter`, a container image and a staging deployment verified end
   to end.
