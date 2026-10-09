# FLOWOS security model

Status: implemented controls are listed with the test that verifies them.
Anything not verified is marked as such. This is not a claim of production
readiness — see "Known gaps" at the end.

## Authentication and sessions

| Control                                                                                                 | Where                         | Verified by          |
| ------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------- |
| scrypt password hashing (N=2^15, r=8, p=1, 16-byte salt), constant-time compare                         | `server/src/auth/password.ts` | `foundation.test.ts` |
| Password policy: ≥10 chars with a letter and a digit                                                    | `modules/auth/router.ts`      | `foundation.test.ts` |
| Same error and a dummy hash comparison for unknown emails (no account enumeration by message or timing) | `modules/auth/service.ts`     | `foundation.test.ts` |
| Session token: 256-bit random; DB stores only SHA-256; 30-day expiry with renewal                       | `server/src/auth/session.ts`  | `http.test.ts`       |
| Cookie: `HttpOnly`, `SameSite=Lax`, `Secure` in production, path `/`                                    | `trpc/context.ts`             | `http.test.ts`       |
| Logout deletes the server-side session; forged cookies are ignored                                      | `auth/session.ts`             | `http.test.ts`       |
| Rate limits: login 10/min per IP and per email; signup 5/min per IP                                     | `auth/rateLimit.ts`           | `foundation.test.ts` |
| Post-login redirect (`?next=`) restricted to in-app paths                                               | `client/src/lib/nav.ts`       | E2E                  |

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

## Files

- Type allow-list by magic bytes; HTML/SVG/script-like text and unknown binaries rejected regardless of extension.
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

Residual risk: prompt injection via record text (e.g. a task title) could steer
the model's _read_ behaviour or wording within the user's own permissions; it
cannot execute writes without the user's confirmation.

## Secrets

- Configuration is validated at startup; error messages name variables only, never values.
- `.env*` files are git-ignored (only `.env.example` is committed).
- No credentials are hard-coded. No AI key is required; when absent the assistant reports that it is not configured.
- The e2e AI harness (`e2e/ai-harness.ts`) injects a scripted provider for testing; it is not imported by the application.

## Dependency audit

`npm audit` reports 4 moderate advisories, all in `drizzle-kit`'s bundled
`@esbuild-kit` (esbuild dev-server CORS issue, GHSA-67mh-4wv8-2f99). drizzle-kit
is a dev-only CLI that does not run the affected dev server. Runtime
dependencies report no known vulnerabilities.

## Known gaps (not yet implemented)

- **Rate limiting is in-memory** — per process only. A multi-instance deployment needs a shared store (e.g. Postgres or Redis).
- **No email delivery**: password reset, email verification and invitation emails do not exist. Invitations are shared as links by the inviter.
- **No MFA / SSO.**
- **No account deletion / data export** (GDPR workflows). Note: user deletion is currently blocked by the append-only audit trigger (actor reference) — a dedicated anonymization path is required.
- **No row-level security in Postgres**; isolation relies on service scoping plus composite FKs.
- **No malware scanning** of uploads.
- **No session listing/revocation UI** beyond logout.
- Penetration testing and a third-party review have not been performed.
