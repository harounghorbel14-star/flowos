# FLOWOS implementation status

Last verified: 2026-10-09, branch `claude/flowos-foundation`.

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

| Gate                                                        | Command                                                 | Result                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| Formatting                                                  | `npm run format:check`                                  | pass                                                                    |
| Lint                                                        | `npm run lint`                                          | pass (0 warnings)                                                       |
| Type check                                                  | `npm run typecheck`                                     | pass                                                                    |
| Integration tests (real PostgreSQL 16, real migrations)     | `npm test`                                              | 89 / 89 pass                                                            |
| Production build                                            | `npm run build`                                         | pass                                                                    |
| Migrations from empty database                              | test global setup + `npm run db:migrate`                | pass (8 migrations)                                                     |
| Browser E2E (2 users, 24 steps, desktop + mobile + dark)    | `npm run test:e2e`                                      | pass against dev servers and against the production build (`npm start`) |
| Assistant UI E2E (scripted test provider, real server + DB) | `npm run e2e:ai-harness` + `npm run test:e2e:assistant` | pass (5 steps)                                                          |

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

### Phase H — AI operations assistant: IMPLEMENTED BUT UNVERIFIED against the live model

Everything except a live model call is implemented and tested. **No
`ANTHROPIC_API_KEY` exists in the build environment, so no request has been
sent to the Anthropic API.** The assistant logic, tools, confirmation flow,
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
| Rate limiting                                                                                                                             | IMPLEMENTED AND VERIFIED         | 20 turns/min per user (in-memory); one turn at a time per conversation                                         |

Tools — read: operational snapshot, search people, get person, list tasks,
get task, list projects, my approvals, search document metadata. Write
(confirmation always): create task, update task status.

- Files: `server/src/modules/ai/{provider,tools,assistant,router,http}.ts`, `client/src/pages/Assistant.tsx`, `e2e/{ai-harness.ts,assistant.mjs}`
- DB: `ai_conversations`, `ai_messages`, `ai_actions`, `ai_tool_calls`, `ai_usage`
- Tests: `ai.test.ts` (10), `ai-http.test.ts` (1). Mutation check: making `create_task` skip confirmation fails 2 tests.
- Not implemented: retrieval over document contents (RAG), structured-output reports, more write tools (approvals, workflows), per-org AI budgets, conversation export.

### Phase I — Global search: IMPLEMENTED AND VERIFIED

Cmd/Ctrl+K palette across people, departments, projects, tasks (title or key),
approvals (only visible ones) and documents (respecting restricted
visibility); quick navigation and create actions. Prefix-ranked `ILIKE`
queries; no vector search (no concrete need yet).

### Phase J — Company intelligence: PARTIALLY IMPLEMENTED

Measured, explainable signals exist (overdue/blocked counts, project risk
reasons, completed-in-7-days, workflow failure counts). Not implemented:
trends over time, "what changed this week" summaries, any causal analysis.

### Phase K — Billing and integrations: NOT IMPLEMENTED

Reason: deliberately deferred until the core product is stable. No Stripe,
Google Workspace, Microsoft 365, Slack, Teams, QuickBooks, HubSpot or WhatsApp
code exists. Extension points that exist today: `StorageAdapter`, the
workflow action registry, and the outbox event stream.

### Design and UX: IMPLEMENTED AND VERIFIED (E2E + visual review)

Operational-editorial design system (warm paper/graphite, restrained teal,
Fraunces + IBM Plex), light/dark, reduced motion, responsive layout with a
mobile navigation drawer (no horizontal overflow at 390 px — checked in E2E),
keyboard-accessible dialogs on native `<dialog>`, command palette with
arrow-key navigation, skeletons, empty and error states, toasts.
Not done: i18n, formal accessibility audit (WCAG), drag-and-drop.

## Known defects

None open. Defects found and fixed during this work:

1. Post-signup redirect raced the auth-route redirect, sending invited users to onboarding instead of back to their invitation (found by E2E).
2. Workflow dispatcher matched events to workflows created after the event (found by integration tests).
3. Migrate-on-start silently applied a superseded draft migration in development; migrations are now an explicit step.
4. Audit summaries showed raw enum values; now human labels.
5. The assistant offered `update_task_status` to read-only viewers (execution would still have been refused by the task service); the tool now requires `task:write_own` (found by tests).
6. Tool-input parse failures from the SDK surface as `AnthropicError`, not `SyntaxError`; the retry path now catches the right class (found by reading the SDK source).
7. A response cut off mid tool call would have left a `tool_use` without a `tool_result`, making the next request invalid; such calls are now recorded as not executed (found in self-review, covered by a test).

## Next recommended phase

1. **Verify the live assistant** with a real `ANTHROPIC_API_KEY`: run a set of
   representative questions, review answers against the data, check token
   usage and cache-read rates in `ai_usage`, then mark the adapter verified.
2. **Production hardening**: shared rate-limit store, email delivery for
   invitations and password reset, an S3-compatible `StorageAdapter`, CI.
3. **Phase J** — trends and "what changed this week" from the audit and
   outbox streams.
