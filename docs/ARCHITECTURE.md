# FLOWOS architecture

This describes the code that exists in this repository today. Planned work is
listed separately in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

## Stack decision

The repository was empty when work began, so there was no existing stack to
preserve. The brief named React/Vite + Express/tRPC + Drizzle on MySQL. We
kept everything except the database:

| Layer    | Choice                                                             |
| -------- | ------------------------------------------------------------------ |
| Client   | React 19, Vite 7, TanStack Query 5, React Router 7, tRPC client 11 |
| API      | Express 5, tRPC 11, Zod 3, superjson                               |
| Data     | PostgreSQL 16, Drizzle ORM 0.45 + drizzle-kit migrations           |
| Tests    | Vitest 5 against a real Postgres database; Playwright for E2E      |
| Language | TypeScript (strict, `noUncheckedIndexedAccess`) end to end         |

**Why PostgreSQL instead of MySQL:** PostgreSQL was the only database
available in the build environment, and every feature here is verified against
a real database. It also gives us features the design depends on: composite
foreign keys with column-list `ON DELETE SET NULL (col)` (tenant integrity),
`FOR UPDATE SKIP LOCKED` (the job queue), partial unique indexes and
triggers (append-only audit log). Moving to MySQL would require replacing
those mechanisms.

## Repository layout

```
shared/            Domain vocabulary used by both sides (enums, labels, permissions, workflow model)
server/src/
  app.ts           Express app: security headers, CSRF guard, tRPC + document routes, static client
  index.ts         Process entry: optional migrations, HTTP server, workflow worker
  env.ts           Validated configuration (never prints values)
  auth/            Password hashing, sessions, rate limiting
  db/              Drizzle schema, client, migration runner
  lib/             Actor, audit writer, outbox emitter, errors, reference validators, pagination
  storage/         Storage adapter interface, local private disk adapter, content sniffing
  trpc/            Context, procedures (public / authed / org-scoped), root router
  modules/<name>/  service.ts (business logic) + router.ts (API surface) [+ http.ts]
server/test/       Integration tests (real Postgres, real migrations)
client/src/
  components/      Design-system primitives, shell, command palette, form dialogs
  pages/           One file per screen
  lib/             tRPC client, session/org context, formatting, uploads
drizzle/           SQL migrations (generated + hand-written integrity migrations)
e2e/               Browser smoke test (Playwright)
```

## Request flow and boundaries

```
Browser ──► Express (helmet, CSRF guard) ──► tRPC procedure
                                               │  publicProcedure / authedProcedure / orgProcedure
                                               ▼
                                         router.ts  (Zod input validation only)
                                               ▼
                                         service.ts (authorization, business rules, transactions,
                                                     audit, notifications, outbox events)
                                               ▼
                                         Drizzle ──► PostgreSQL (constraints, composite FKs, triggers)
```

- **Routers** validate input shape and call one service function. No business logic.
- **Services** receive an `Actor` and enforce permissions with `assertCan`, scope
  every query by `actor.orgId`, validate cross-entity references with
  `lib/refs.ts`, and perform multi-record changes in one transaction that also
  writes the audit event (and outbox event, where relevant).
- **The database** independently enforces tenant integrity: tenant-owned
  references use composite foreign keys `(org_id, ref_id) → (org_id, id)`, so a
  row cannot point at another organization's record even if a service had a bug.
- Services are plain functions over `(db | tx, actor, input)` — the same
  functions are called by the API, by workflow actions, and by tests.

## Identity and tenancy

- `users` / `sessions`: session token is 256-bit random; only its SHA-256 is stored.
- `organizations` / `memberships` / `invitations`.
- Every org-scoped request carries `x-flowos-org`. `orgProcedure` (and the
  plain document routes, via the shared `loadActor`) re-reads the membership from
  the database on **every request** and builds the `Actor { userId, orgId, role }`.
  Client-supplied roles are never used.
- Roles map to permissions in `shared/permissions.ts`. The client uses the same
  table only to hide controls; the server is the authority.

## Audit log

`audit_events` is append-only. Triggers reject `UPDATE`, `DELETE` and `TRUNCATE`
for every caller. The API exposes only a read procedure. Mutations write their
audit event inside the same transaction, so an event exists iff the change
committed.

## Workflow engine

```
service mutation ──(same tx)──► domain_events (outbox)
                                     │ worker tick (every 2 s, in-process, non-overlapping)
                                     ▼
            dispatchEvents: SKIP LOCKED claim → match enabled workflows that existed when the
                            event happened → evaluate conditions → insert workflow_runs
                            (UNIQUE(workflow_id, event_id) = at most one run per event)
                                     ▼
            runDueWorkflows: claim PENDING (or stale RUNNING) runs with SKIP LOCKED →
                             for each not-yet-succeeded step: BEGIN; action; insert step; COMMIT
```

- Each step's side effect and its `SUCCEEDED` step row commit together, and a
  partial unique index allows one success per (run, step). Retries therefore
  resume after the last successful step and never repeat side effects.
- Transient errors back off (30 s × 2^attempt) up to `max_attempts`; permanent
  errors (domain validation, missing references, revoked owner) fail fast.
  Final failure is audited and notifies the workflow owner. A run is marked
  `SUCCEEDED` only after every step succeeded.
- Actions execute as the workflow **owner with their current role**, through the
  same service functions as the API (so validation, permission checks, audit and
  notifications apply). Saving a workflow makes the saver its owner.
- Actions are a fixed registry (`create_task`, `notify`) with plain-text
  `{{field}}` templates. No user-supplied code is executed.
- Runs snapshot their actions at dispatch, so editing a workflow cannot change
  an in-flight run. Events produced ≥3 workflow hops deep are not dispatched.
- The worker also sends document expiry reminders.
- Set `FLOWOS_WORKER=false` on API-only replicas. Multiple workers are safe
  (SKIP LOCKED + unique constraints).

## Documents

- Upload: `POST /api/documents/upload` (raw bytes, metadata in a header,
  CSRF-guarded, 10 MB). Type comes from magic bytes; only PDF, PNG, JPEG,
  DOCX/XLSX/PPTX and plain text/CSV/Markdown are accepted.
- Storage: `StorageAdapter` (`put/get/delete`). `LocalDiskStorage` writes 0600
  files under `STORAGE_DIR` with random keys. No public URLs exist.
- Download: `GET /api/documents/:id/download?org=` re-verifies session and
  membership and applies the visibility rule in SQL; responds as an attachment
  with `nosniff`, `no-store` and a sandboxing CSP; each download is audited.

## Command center and search

- The command center is a set of SQL counts and short lists over the actor's
  organization. The briefing is generated by fixed rules from those counts —
  it is labelled "Rule-based · live data" and involves no AI.
- Project risk is a list of explicit, measured reasons (past due; due within 7
  days with <70 % of tasks done; overdue tasks; blocked tasks).
- Global search runs one `ILIKE` query per module the actor may read, with
  visibility filters in SQL (approvals, restricted documents). No vector store:
  there is no concrete need yet.

## Client

- `SessionProvider` holds the user, memberships and the selected organization
  (remembered in `localStorage`). Switching organization removes every cached
  query so no data from the previous tenant is displayed.
- List screens keep filters in the URL (shareable, back-button friendly).
- The design system lives in `client/src/styles.css` (tokens on `:root`, dark
  theme, reduced motion) and `components/ui.tsx` (Button, fields, Modal on the
  native `<dialog>`, ConfirmDialog, badges, empty/error/loading states).

## Key decisions

| Decision                                        | Reason                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| Composite tenant FKs in hand-written migrations | Drizzle cannot express `ON DELETE SET NULL (col)`; keeps `org_id` intact  |
| Server-side sessions over JWT                   | Instant revocation on logout/removal; no token parsing on the client      |
| Custom header + Origin check for CSRF           | Works with SameSite=Lax cookies and tRPC batching without token plumbing  |
| Outbox + in-process worker on Postgres          | Exactly-once dispatch semantics without adding Redis/queue infrastructure |
| Migrations as an explicit step                  | Avoids replicas racing and silently applying unreviewed migrations        |
| Rule-based briefing, no AI                      | No AI provider is configured; the brief forbids invented insights         |
