# FLOWOS

**The operating system for business operations.** FLOWOS connects people,
projects, tasks, approvals, documents and automation in one multi-tenant
workspace, organised around a single question: _what needs my attention, why
does it matter, and what should happen next?_

> Status: early product, not deployed. See
> [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) for exactly
> what is built and verified.

## What works today

- **Command center** — live counts and a rule-based briefing: your overdue work, decisions waiting on you, projects at risk (with the measured reasons), deadlines, expiring documents, workflow failures.
- **People** — directory, profiles, departments, reporting lines, employment status.
- **Projects & tasks** — per-org task keys, statuses, priorities, assignees, due dates, comments, history, project boards and real progress.
- **Approvals** — leave, HR, purchase, document and general requests with a named approver and a complete decision trail.
- **Workflows** — WHEN → IF → THEN automation (e.g. onboarding tasks when someone joins) with retries, idempotency and run history.
- **Documents** — private storage, restricted visibility, audited downloads, expiry reminders.
- **Insights** — week-over-week throughput, overdue history, approval turnaround and workflow reliability, each with its definition.
- **Search** — Cmd/Ctrl+K across everything you are allowed to see.
- **Assistant** — ask about live data; it uses only tools your role allows and every change waits for your explicit confirmation (requires `ANTHROPIC_API_KEY`; not yet verified against the live API).
- **Security** — tenant isolation enforced in services _and_ the database, role-based permissions, append-only audit log.

Also built: billing plans with Stripe (verified with a fake Stripe in tests, not against Stripe itself) and Slack/Teams incoming webhooks (delivery to a real channel not verified yet). Not built: email delivery, OAuth integrations. See the status doc.

## Quick start

```bash
npm install
cp .env.example .env
createdb flowos && npm run db:migrate
npm run db:seed        # optional demo data (local only)
npm run dev            # http://localhost:5173
```

Full instructions, configuration and the production checklist:
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Documentation

- [Implementation status](docs/IMPLEMENTATION_STATUS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security model](docs/SECURITY.md)
- [Running and deploying](docs/DEPLOYMENT.md)
- [Web app testing guide](docs/WEB_TESTING_GUIDE.md)
- [Staging deployment](docs/STAGING.md)

## Checks

```bash
npm run check      # format, lint, typecheck, integration tests, build
npm run test:e2e   # browser scenario against a running app
```
