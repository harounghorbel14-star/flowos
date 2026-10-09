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

| Gate                                                     | Command                                  | Result                                                    |
| -------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------- |
| Formatting                                               | `npm run format:check`                   | pass                                                      |
| Lint                                                     | `npm run lint`                           | pass (0 warnings)                                         |
| Type check                                               | `npm run typecheck`                      | pass                                                      |
| Integration tests (real PostgreSQL 16, real migrations)  | `npm test`                               | 78 / 78 pass                                              |
| Production build                                         | `npm run build`                          | pass                                                      |
| Migrations from empty database                           | test global setup + `npm run db:migrate` | pass (6 migrations)                                       |
| Browser E2E (2 users, 23 steps, desktop + mobile + dark) | `npm run test:e2e`                       | pass against dev servers and against the production build |

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

### Phase H — AI operations assistant: NOT IMPLEMENTED

Reason: not yet built in this branch; additionally no `ANTHROPIC_API_KEY` is
configured in the build environment, so live model calls cannot be verified.
The briefing on the command center is explicitly rule-based.

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

## Next recommended phase

Phase H — AI operations assistant on top of the existing services: provider
abstraction, permission-aware tool registry using service functions, prepared
actions with explicit confirmation bound to the actor, persisted
conversations, and usage tracking. Live model calls need an API key to verify.
