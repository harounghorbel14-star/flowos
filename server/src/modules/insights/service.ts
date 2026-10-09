import { sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import { approvalRequests, auditEvents, tasks, users, workflowRuns, workflows } from "../../db/schema";
import { assertCan, can, type Actor } from "../../lib/actor";

/**
 * Operational trends. Every figure is a direct aggregate over this
 * organization's records, and each comes with the definition shown in the UI.
 * Weeks are ISO weeks (Monday 00:00 UTC); the current week is partial.
 */
export const DEFINITIONS = {
  created: "Tasks whose creation date falls in the week.",
  completed:
    "Tasks whose current completion date falls in the week. A task reopened later no longer counts; deleted tasks are not included.",
  overdue:
    "Open tasks past their due date at the end of each week (or now, for the current week), reconstructed from today's records: creation, due and completion dates. Tasks deleted since are not included.",
  turnaround:
    "Median hours from submission to decision for approval requests decided in the week (cancelled requests excluded).",
  workflowRuns:
    "Workflow runs created in the week, by final status. Runs still pending are shown separately.",
  rolling:
    "Last 7 days compared with the 7 days before; rolling windows avoid comparing a partial week to a full one.",
} as const;

const WEEKS = 8;

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function operationalTrends(db: Database, actor: Actor) {
  assertCan(actor, "task:read");
  const org = actor.orgId;

  // Series of week starts, oldest first, ending with the current (partial) week.
  const weeksCte = sql`weeks as (
    select generate_series(
      date_trunc('week', now()) - ${`${WEEKS - 1} weeks`}::interval,
      date_trunc('week', now()),
      interval '1 week'
    ) as week_start
  )`;

  const throughputQ = db.execute<Row>(sql`
    with ${weeksCte}
    select to_char(w.week_start, 'YYYY-MM-DD') as week,
      (select count(*) from ${tasks} t where t.org_id = ${org}
         and t.created_at >= w.week_start and t.created_at < w.week_start + interval '1 week') as created,
      (select count(*) from ${tasks} t where t.org_id = ${org}
         and t.completed_at >= w.week_start and t.completed_at < w.week_start + interval '1 week') as completed,
      (select count(*) from ${tasks} t
         where t.org_id = ${org}
           and t.created_at <= least(w.week_start + interval '1 week', now())
           and t.due_date < (least(w.week_start + interval '1 week', now()))::date
           and (t.completed_at is null or t.completed_at > least(w.week_start + interval '1 week', now()))) as overdue
    from weeks w order by w.week_start`);

  const rollingQ = db.execute<Row>(sql`
    select
      count(*) filter (where created_at >= now() - interval '7 days') as created_now,
      count(*) filter (where created_at >= now() - interval '14 days' and created_at < now() - interval '7 days') as created_prev,
      count(*) filter (where completed_at >= now() - interval '7 days') as completed_now,
      count(*) filter (where completed_at >= now() - interval '14 days' and completed_at < now() - interval '7 days') as completed_prev
    from ${tasks} where org_id = ${org}`);

  const approvalsQ = can(actor, "approval:read_all")
    ? db.execute<Row>(sql`
        with ${weeksCte}
        select to_char(w.week_start, 'YYYY-MM-DD') as week,
          count(a.id) as decided,
          percentile_cont(0.5) within group (order by extract(epoch from (a.decided_at - a.created_at)) / 3600)
            filter (where a.id is not null) as median_hours
        from weeks w
        left join ${approvalRequests} a on a.org_id = ${org}
          and a.status in ('APPROVED', 'REJECTED')
          and a.decided_at >= w.week_start and a.decided_at < w.week_start + interval '1 week'
        group by w.week_start order by w.week_start`)
    : Promise.resolve(null);

  const approvalsRollingQ = can(actor, "approval:read_all")
    ? db.execute<Row>(sql`
        select
          count(*) filter (where decided_at >= now() - interval '7 days') as decided_now,
          count(*) filter (where decided_at >= now() - interval '14 days' and decided_at < now() - interval '7 days') as decided_prev,
          count(*) filter (where status = 'PENDING') as pending,
          percentile_cont(0.5) within group (order by extract(epoch from (now() - created_at)) / 3600)
            filter (where status = 'PENDING') as pending_median_age_hours
        from ${approvalRequests}
        where org_id = ${org} and status <> 'CANCELLED'`)
    : Promise.resolve(null);

  const workflowsQ = can(actor, "workflow:read")
    ? db.execute<Row>(sql`
        with ${weeksCte}
        select to_char(w.week_start, 'YYYY-MM-DD') as week,
          count(r.id) filter (where r.status = 'SUCCEEDED') as succeeded,
          count(r.id) filter (where r.status = 'FAILED') as failed,
          count(r.id) filter (where r.status in ('PENDING', 'RUNNING')) as in_flight
        from weeks w
        left join ${workflowRuns} r on r.org_id = ${org}
          and r.created_at >= w.week_start and r.created_at < w.week_start + interval '1 week'
        group by w.week_start order by w.week_start`)
    : Promise.resolve(null);

  const failingQ = can(actor, "workflow:read")
    ? db.execute<Row>(sql`
        select wf.id, wf.name,
          count(*) filter (where r.status = 'FAILED') as failed,
          count(*) as runs
        from ${workflowRuns} r join ${workflows} wf on wf.org_id = r.org_id and wf.id = r.workflow_id
        where r.org_id = ${org} and r.created_at >= now() - interval '30 days'
        group by wf.id, wf.name
        having count(*) filter (where r.status = 'FAILED') > 0
        order by failed desc, runs desc limit 5`)
    : Promise.resolve(null);

  // Notable changes in the last 7 days, from the audit log, limited to records every member may see.
  const notableQ = db.execute<Row>(sql`
    select e.action, e.summary, e.entity_type, e.entity_id, e.created_at, u.name as actor_name
    from ${auditEvents} e left join ${users} u on u.id = e.actor_user_id
    where e.org_id = ${org}
      and e.created_at >= now() - interval '7 days'
      and e.action in ('project.created', 'project.status_changed', 'employee.created', 'employee.status_changed', 'department.created')
    order by e.created_at desc limit 10`);

  const [throughput, rolling, approvals, approvalsRolling, workflowWeeks, failing, notable] =
    await Promise.all([throughputQ, rollingQ, approvalsQ, approvalsRollingQ, workflowsQ, failingQ, notableQ]);

  const r = rolling.rows[0] ?? {};
  const ar = approvalsRolling?.rows[0];
  return {
    generatedAt: new Date(),
    definitions: DEFINITIONS,
    weeks: throughput.rows.map((row) => ({
      week: String(row.week),
      created: num(row.created),
      completed: num(row.completed),
      overdue: num(row.overdue),
    })),
    rolling: {
      created: { current: num(r.created_now), previous: num(r.created_prev) },
      completed: { current: num(r.completed_now), previous: num(r.completed_prev) },
      approvalsDecided: ar ? { current: num(ar.decided_now), previous: num(ar.decided_prev) } : null,
    },
    approvals: approvals
      ? {
          weeks: approvals.rows.map((row) => ({
            week: String(row.week),
            decided: num(row.decided),
            medianHours: numOrNull(row.median_hours),
          })),
          pending: num(ar?.pending),
          pendingMedianAgeHours: numOrNull(ar?.pending_median_age_hours),
        }
      : null,
    workflows: workflowWeeks
      ? {
          weeks: workflowWeeks.rows.map((row) => ({
            week: String(row.week),
            succeeded: num(row.succeeded),
            failed: num(row.failed),
            inFlight: num(row.in_flight),
          })),
          failing: (failing?.rows ?? []).map((row) => ({
            id: String(row.id),
            name: String(row.name),
            failed: num(row.failed),
            runs: num(row.runs),
          })),
        }
      : null,
    notable: notable.rows.map((row) => ({
      action: String(row.action),
      summary: String(row.summary),
      entityType: String(row.entity_type),
      entityId: row.entity_id ? String(row.entity_id) : null,
      at: new Date(row.created_at as string | Date),
      actorName: row.actor_name ? String(row.actor_name) : null,
    })),
  };
}
