# FLOWOS security model

Status: implemented controls are listed with the test that verifies them.
Anything not verified is marked as such. This is not a claim of production
readiness — see "Known gaps" at the end.

## Authentication and sessions

Password change (current password required, rate limited) and "sign out other devices" are available under Settings → Account; both are audited.

Password reset ("Forgot password?"): the request answers identically for every email and looks the account up only after responding, so neither content nor timing reveals registered emails; 5 requests per 15 minutes per IP and per email. A reset link carries a 256-bit random token stored only as its SHA-256, is built from `APP_ORIGIN` (never from request headers), works once (row-locked), expires after 1 hour, is cancelled by a newer link, and on use revokes every session of the account. Emails are plain text over SMTP (`SMTP_URL` is a secret and never logged). Without SMTP an operator with database access creates links with `reset-link`. Requests, operator links and resets are audited (`password-reset.test.ts`).

| Control                                                                                                                                                                                                                                                      | Where                         | Verified by                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ----------------------------------------- |
| scrypt password hashing (N=2^15, r=8, p=1, 16-byte salt), constant-time compare                                                                                                                                                                              | `server/src/auth/password.ts` | `foundation.test.ts`                      |
| Password policy: ≥10 chars with a letter and a digit                                                                                                                                                                                                         | `modules/auth/router.ts`      | `foundation.test.ts`                      |
| Same error and a dummy hash comparison for unknown emails (no account enumeration by message or timing)                                                                                                                                                      | `modules/auth/service.ts`     | `foundation.test.ts`                      |
| Session token: 256-bit random; DB stores only SHA-256; 30-day expiry with renewal                                                                                                                                                                            | `server/src/auth/session.ts`  | `http.test.ts`                            |
| Cookie: `HttpOnly`, `SameSite=Lax`, `Secure` in production, path `/`                                                                                                                                                                                         | `trpc/context.ts`             | `http.test.ts`                            |
| Logout deletes the server-side session; forged cookies are ignored                                                                                                                                                                                           | `auth/session.ts`             | `http.test.ts`                            |
| Rate limits: login 10/min per IP and per email; signup 5/min per IP; assistant 20 turns/min per user. Fixed windows stored in PostgreSQL (one atomic upsert per hit), so limits hold across all API instances; identifiers are SHA-256 hashed before storage | `auth/rateLimit.ts`           | `foundation.test.ts`, `ratelimit.test.ts` |
| Post-login redirect (`?next=`) restricted to in-app paths                                                                                                                                                                                                    | `client/src/lib/nav.ts`       | E2E                                       |

## Request integrity

| Control                                                                                                                                                        | Where                         | Verified by                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------- |
| CSRF: state-changing API requests need `x-flowos-client: web` (forces a CORS preflight we never grant) and, if `Origin` is present, it must equal `APP_ORIGIN` | `app.ts` `csrfGuard`          | `http.test.ts`, `documents.test.ts`                      |
| Security headers via helmet: strict CSP (`script-src 'self'`, `frame-ancestors 'none'`), `nosniff`, no `x-powered-by`                                          | `app.ts`                      | `http.test.ts`; full E2E passes under the production CSP |
| Input validation with Zod on every procedure; LIKE wildcards escaped in search                                                                                 | routers, `lib/pagination.ts`  | `people.test.ts`                                         |
| Internal errors are masked in production; Zod field errors returned for forms                                                                                  | `trpc/trpc.ts`                | —                                                        |
| Body size limits: JSON 1 MB, uploads 10 MB                                                                                                                     | `app.ts`, `documents/http.ts` | `documents.test.ts`                                      |

## Multi-tenancy (Organization A must never see Organization B)

1. **Membership on every request.** `loadActor` reads the membership row for
   (user, requested org) on each request. Non-members get `FORBIDDEN`; a
   removed member loses access on the next request.
2. **Every tenant query is scoped by `actor.orgId`** in services. Lookups by ID
   include the org filter, so a guessed ID from another tenant is `NOT_FOUND`
   (identical to "does not exist").
3. **References are validated** against the actor's org before writing
   (`lib/refs.ts`): departments, managers, assignees, projects, linked
   accounts, document subjects, workflow targets.
4. **The database enforces it too.** Composite foreign keys
   `(org_id, ref) → (org_id, id)` reject cross-tenant references even if a
   service is bypassed (`people.test.ts` inserts raw SQL to prove it).

Tested with guessed IDs across tenants for: employees, departments, projects,
tasks, comments, memberships, approvals, workflows, workflow runs, documents
(including download), search results and filters. A mutation test (removing the
org filter from `getTask`) was confirmed to fail the suite.

## Authorization

Roles: OWNER > ADMIN > MANAGER > MEMBER > VIEWER, mapped to explicit
permissions in `shared/permissions.ts` and enforced in services.

- Members can only edit tasks they created or are assigned; viewers are read-only.
- Role changes and removals obey rank rules; an organization keeps at least one owner (row-locked check).
- Approvals: only the designated approver decides; the requester cannot approve their own request; non-involved members cannot see a request.
- Restricted documents: visible only to document managers, the uploader and the employee they concern — enforced in SQL for list, search and download.
- Workflows execute as their owner with the owner's **current** role. Demoting or removing the owner makes subsequent runs fail rather than act with stale privileges (`workflows.test.ts`).

## Audit log

- Append-only: triggers raise on `UPDATE`, `DELETE`, `TRUNCATE` (`foundation.test.ts`).
- The API exposes only `audit.list` (requires `audit:read`); a test asserts no other audit procedures exist.
- Written in the same transaction as the change. Covers sign-in, membership, invitations, people, departments, projects, tasks, comments, approvals, workflows (including run failures and retries), and document upload/download/update/delete.

## Concurrency and idempotency

- Approval decisions use a guarded `UPDATE … WHERE status = 'PENDING'`; concurrent decisions → exactly one succeeds (`approvals.test.ts`).
- Invitations are single-use via conditional update.
- Task numbers are allocated under a row lock (concurrent creation test).
- Workflow runs: `UNIQUE(workflow_id, event_id)`, `SKIP LOCKED` claiming, and one-success-per-step index (`workflows.test.ts`).
- Document expiry reminders are claimed with a conditional update (sent once).
- At most one open invitation per (organization, email): partial unique index (migration 0009); concurrent invites leave exactly one (`hardening.test.ts`).
- Manager changes take a per-organization advisory lock before the reporting-cycle check.
- Assistant turns: one per conversation; the lock is renewed before each model request and released only by its owner, so a slow turn cannot corrupt the transcript of a newer one (`ai.test.ts`).
- Workflow runs abandoned on their final attempt (process crash) are failed and the owner notified, never retried forever (`workflows.test.ts`).
- A repeated identical approval decision returns 409 ("already approved"); the UI disables the button while a decision is pending.

## Files

- Type allow-list by magic bytes; HTML/SVG/script-like text and unknown binaries rejected regardless of extension.
- Uploads authenticate the session, membership and `document:upload`, and apply a 30/min per-user limit, **before** reading the 10 MB body (`documents.test.ts`).
- Sanitized file names; random storage keys validated against a strict pattern before touching the filesystem (no path traversal).
- Files written `0600` in a `0700` directory outside the web root; downloads only via the authorized endpoint with `Content-Disposition: attachment`, `nosniff`, `Cache-Control: private, no-store`, `CSP: default-src 'none'; sandbox`.

## AI assistant

| Control                                                                                                                                                                                                                                   | Where                                       | Verified by                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------ |
| Model runs server-side; API key only in server env; never sent to the browser                                                                                                                                                             | `modules/ai/provider.ts`                    | code review                                |
| Model sees only tools the user's role permits; each tool calls the normal service functions as the user (same tenant scoping and checks)                                                                                                  | `modules/ai/tools.ts`                       | `ai.test.ts` (viewer, cross-tenant)        |
| Tool inputs validated with Zod before use (inputs stream un-validated from the API)                                                                                                                                                       | `assistant.ts` `runTool`                    | `ai.test.ts`                               |
| Writes are only _prepared_; execution requires a separate user request with the action ID and the SHA-256 of the exact input, by the same user in the same org, before expiry (10 min), once, with permissions re-checked at confirm time | `assistant.ts` `confirmAction`              | `ai.test.ts`, browser E2E; mutation-tested |
| Chat text ("yes, confirm") cannot execute anything                                                                                                                                                                                        | system prompt + no code path                | `ai.test.ts`, browser E2E                  |
| Tool results are labelled as data, never instructions; document contents are never sent to the model (metadata only)                                                                                                                      | system prompt, tool set                     | code review                                |
| Refused (partial) output is discarded, never stored or acted on                                                                                                                                                                           | `runTurn`                                   | `ai.test.ts`                               |
| Conversations private to their user; transcript append-only (DB trigger)                                                                                                                                                                  | schema, migration 0007                      | `ai.test.ts`                               |
| Proposals and confirmed executions are audited; every tool call and model request is logged with outcome/usage                                                                                                                            | `ai_tool_calls`, `ai_usage`, `audit_events` | `ai.test.ts`                               |
| Rate limit 20 turns/min/user; one turn at a time per conversation                                                                                                                                                                         | `assistant.ts`                              | `ai.test.ts`                               |
| Confirmation cards name what changes: task number, title, current and new status; assignee, project, due date. A reference to another organization's record prepares nothing                                                              | `tools.ts` `describe`                       | `ai.test.ts`                               |
| A client disconnect aborts the turn and the model request; history is bounded to whole recent exchanges                                                                                                                                   | `http.ts`, `fitHistory`                     | `ai.test.ts`                               |

Residual risk: prompt injection via record text (e.g. a task title) could steer
the model's _read_ behaviour or wording within the user's own permissions; it
cannot execute writes without the user's confirmation.

## Secrets

- Configuration is validated at startup; error messages name variables only, never values.
- `.env*` files are git-ignored (only `.env.example` is committed).
- No credentials are hard-coded. No AI key is required; when absent the assistant reports that it is not configured.
- The e2e AI harness (`e2e/ai-harness.ts`) injects a scripted provider for testing; it is not imported by the application.
- Logs never include query parameters: internal errors pass through `logSafeError`, which reduces database errors to SQLSTATE and table/constraint (drizzle's message embeds every bound value, e.g. password hashes) (`hardening.test.ts`).
- Production builds ship no source maps.
- `.env.example` must keep `ANTHROPIC_API_KEY=` empty: an empty value means "not configured", while a placeholder string would make the server try to call the API with it.

### Incident: credential committed to `.env.example` (2026-10-09)

- Commit `76ad080` on `main` set `ANTHROPIC_API_KEY` in `.env.example` to a
  106-character, high-entropy value with an Anthropic credential prefix. It is
  not a placeholder and must be treated as a **real, compromised credential**.
  It was not used or tested by this work.
- **Required action (owner): revoke it in the Anthropic Console** and issue a
  new key that is stored only as a secret (see [DEPLOYMENT.md](DEPLOYMENT.md#configuring-the-anthropic-api-key)).
  Status as of the stabilization pass: revocation not confirmed by the owner.
  Never reuse this value.
- The value is removed from the working tree by the stabilization PR. It is
  still in git history (`76ad080`, and as the removed line of the fixing
  commit) and in any clone or fork made since. History has **not** been
  rewritten: that needs a force-push to `main` and is only worthwhile together
  with revocation. Revocation is what makes the exposure harmless.
- A full-history scan (all branches) for Anthropic, OpenAI-style, AWS, GitHub,
  Slack, Stripe and Google keys and PEM private keys found no other credential.
  The only `.env*` file ever tracked is `.env.example`.

## Billing and integrations

- **Stripe webhooks** are authenticated by the signature over the raw body (Stripe SDK, 300 s tolerance) and are not CSRF-guarded; unverifiable requests get 400 and nothing is recorded. Each event id is stored in the same transaction as its effect (redelivery is a no-op; a failed event leaves nothing and Stripe retries). Subscription events are treated as signals: the current subscription is read back from Stripe and stored, so event order and duplicates cannot roll state back. An organization id claimed by an event is used only if the Stripe customer belongs to it (`billing.test.ts`).
- **Checkout/portal**: owners only (`billing:manage`); redirect URLs come from `APP_ORIGIN` only; checkout is refused when an open subscription exists in FLOWOS or at Stripe; if two subscriptions become active anyway, the active one is never replaced or downgraded and owners are alerted. Plan limits and features are enforced in the services under a per-organization row lock (no count-then-insert race). Feature flags are operator-only.
- **Integration secrets** (webhook URLs) are AES-256-GCM encrypted with `INTEGRATIONS_ENCRYPTION_KEY`, bound to their organization and provider (AAD), with 16-byte tags; never returned by the API (a hint is shown) or logged.
- **SSRF**: webhook URLs must be HTTPS on 443 to the provider's own hosts; at send time the host is resolved once, every address must be public (no loopback, private, link-local/metadata, CGNAT, multicast, IPv4-mapped), the connection is pinned to that address, IP-literal hosts are refused and redirects are never followed (`integrations.test.ts`, real DNS and TLS).
- Only admins and owners (`integration:manage`) connect, test or disconnect; 10 such calls per organization per minute; all audited. Delivery errors never echo the provider's response.

### Security audit of the Phase K code (independent review, all addressed)

| #   | Severity | Finding                                                                               | Status                                                                                                          |
| --- | -------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | Medium   | A second live subscription could be created, and cancelling either downgraded the org | Fixed: checkout checks Stripe; duplicates never replace/downgrade the active one; owners alerted                |
| 2   | Medium   | Event ordering wrong on equal timestamps / late retries                               | Fixed: state re-read from Stripe on every subscription event                                                    |
| 3   | Medium   | Unknown price (rotation, add-on first) dropped even cancellations                     | Fixed: all items scanned, legacy prices, status always applied to a known subscription                          |
| 4   | Medium   | One tenant's slow webhook could stall the shared worker (10 s, inside a transaction)  | Mitigated: 5 s timeout, rate limit; residual risk documented (deliveries still run in the step transaction)     |
| 5   | Low      | Unbounded response body read                                                          | Fixed: body discarded unread                                                                                    |
| 6   | Low      | Limit checks raced (count then insert)                                                | Fixed: organization row lock; reproduced by a test that fails without it                                        |
| 7   | Low      | Failed/aborted assistant requests not counted in the quota                            | Fixed: every request counts                                                                                     |
| 8   | Low      | Delivery failures from workflows rolled back, never shown                             | Fixed: recorded outside the step transaction                                                                    |
| 9   | Low      | No IP check after DNS resolution                                                      | Fixed: resolved addresses checked and pinned                                                                    |
| 10  | Low      | Markdown link injection in Teams messages                                             | Fixed: plain TextRun                                                                                            |
| 11  | Low      | Crypto: tag length, no AAD, malformed key → 500                                       | Fixed (key rotation not implemented: losing or changing the key requires reconnecting integrations)             |
| 12  | Low      | Stale Stripe customer, webhook_events never purged, over-limit data after downgrade   | Purge added (90 days); a deleted Stripe customer and over-limit data after downgrade are documented limitations |

## Dependency audit

`npm audit` reports 4 moderate advisories, all in `drizzle-kit`'s bundled
`@esbuild-kit` (esbuild dev-server CORS issue, GHSA-67mh-4wv8-2f99). drizzle-kit
is a dev-only CLI that does not run the affected dev server. Runtime
dependencies (including `stripe` 22.6.2, pinned) report no known vulnerabilities.

## Known gaps (not yet implemented)

- **Email**: only password reset links are emailed (when SMTP is configured; tested against a local SMTP server, not a real provider). Email verification and invitation emails do not exist; invitations are shared as links by the inviter.
- **Emails are not verified.** Someone can register an address they do not own first; the real owner then cannot sign up, and an invitation link for that address can be accepted by that account. Signup also reveals whether an email is registered. Fixing this needs email delivery (above).
- **No MFA / SSO.**
- **No account deletion / data export** (GDPR workflows). Note: user deletion is currently blocked by the append-only audit trigger (actor reference) — a dedicated anonymization path is required.
- **No row-level security in Postgres**; isolation relies on service scoping plus composite FKs.
- **No malware scanning** of uploads.
- **Sessions**: 30-day sliding expiry capped at 90 days from sign-in; changing the password or "Sign out other devices" revokes every other session (`hardening.test.ts`). The cookie is re-sent only when a request renews the session, so a response still in flight at sign-out cannot restore it (`http.test.ts`). There is no per-device session list.
- Penetration testing and a third-party review have not been performed.
