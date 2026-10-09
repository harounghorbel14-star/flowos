import { TrendingUp } from "lucide-react";
import { Link } from "react-router-dom";
import { ChartTable, ColumnChart, Legend, LineChart, type Series } from "../components/charts";
import { Badge, EmptyState, ErrorState, PageHeader, Panel, SkeletonRows } from "../components/ui";
import { formatDay, timeAgo } from "../lib/format";
import { trpc, type RouterOutputs } from "../lib/trpc";

const THROUGHPUT: Series[] = [
  { key: "created", label: "Created", color: "var(--series-2)" },
  { key: "completed", label: "Completed", color: "var(--series-1)" },
];
const INK: Series = { key: "v", label: "", color: "var(--ink-2)" };

function weekLabel(iso: string, i: number, count: number) {
  return i === count - 1 ? "This week" : formatDay(iso, true);
}

const hours = (h: number) =>
  h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round((h / 24) * 10) / 10} d`;

/** Neutral week-over-week delta: states the change without judging it good or bad. */
function Delta({ current, previous }: { current: number; previous: number }) {
  const diff = current - previous;
  if (diff === 0) return <span className="delta">same as previous 7 days</span>;
  return (
    <span className="delta">
      {diff > 0 ? "▲" : "▼"} {Math.abs(diff)} vs previous 7 days ({previous})
    </span>
  );
}

const NOTABLE_LINK: Record<string, string> = { project: "/projects/", employee: "/people/" };

export function InsightsPage() {
  const q = trpc.insights.trends.useQuery(undefined, { refetchInterval: 120_000 });

  return (
    <>
      <PageHeader
        eyebrow="Learn"
        title="Insights"
        lede="How work is moving, week by week. Every figure is measured from your organization’s records and says how it is calculated — these are facts, not predictions."
      />
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.isLoading ? (
        <div className="panel">
          <SkeletonRows rows={6} />
        </div>
      ) : null}
      {q.data ? <Body data={q.data} /> : null}
    </>
  );
}

type Data = RouterOutputs["insights"]["trends"];

function Body({ data }: { data: Data }) {
  const n = data.weeks.length;
  const cats = data.weeks.map((w, i) => weekLabel(w.week, i, n));
  const anyTasks = data.weeks.some((w) => w.created || w.completed || w.overdue);

  return (
    <div className="stack">
      <div className="metrics" aria-label="Last 7 days">
        <div className="metric">
          <span className="eyebrow">Tasks completed · 7 days</span>
          <span className="value">{data.rolling.completed.current}</span>
          <Delta {...data.rolling.completed} />
        </div>
        <div className="metric">
          <span className="eyebrow">Tasks created · 7 days</span>
          <span className="value">{data.rolling.created.current}</span>
          <Delta {...data.rolling.created} />
        </div>
        <div className="metric">
          <span className="eyebrow">Open overdue now</span>
          <span className="value">{data.weeks[n - 1]?.overdue ?? 0}</span>
          <span className="delta">at end of last week: {data.weeks[n - 2]?.overdue ?? 0}</span>
        </div>
        {data.rolling.approvalsDecided ? (
          <div className="metric">
            <span className="eyebrow">Approvals decided · 7 days</span>
            <span className="value">{data.rolling.approvalsDecided.current}</span>
            <Delta {...data.rolling.approvalsDecided} />
          </div>
        ) : (
          <Link className="metric" to="/approvals">
            <span className="eyebrow">Approvals</span>
            <span className="hint">Organization-wide approval figures are visible to admins.</span>
          </Link>
        )}
      </div>
      <p className="definition">{data.definitions.rolling}</p>

      {!anyTasks ? (
        <div className="panel">
          <EmptyState icon={<TrendingUp size={18} />} title="Not enough history yet">
            Trends appear once tasks are created and completed. Nothing here is estimated.
          </EmptyState>
        </div>
      ) : (
        <div className="grid two">
          <Panel title="Created vs completed" action={<Legend series={THROUGHPUT} kind="rect" />}>
            <ColumnChart
              categories={cats}
              series={THROUGHPUT}
              values={{
                created: data.weeks.map((w) => w.created),
                completed: data.weeks.map((w) => w.completed),
              }}
              ariaLabel="Tasks created and completed per week, last 8 weeks"
            />
            <p className="definition">
              Created: {data.definitions.created} Completed: {data.definitions.completed} This week is
              partial.
            </p>
            <ChartTable
              caption="Tasks created and completed per week"
              categories={cats}
              columns={[
                { label: "Created", values: data.weeks.map((w) => w.created) },
                { label: "Completed", values: data.weeks.map((w) => w.completed) },
              ]}
            />
          </Panel>
          <Panel title="Open overdue tasks at week end">
            <LineChart
              categories={cats}
              series={[{ ...INK, label: "Overdue" }]}
              values={{ v: data.weeks.map((w) => w.overdue) }}
              ariaLabel="Open overdue tasks at the end of each week, last 8 weeks"
            />
            <p className="definition">{data.definitions.overdue}</p>
            <ChartTable
              caption="Open overdue tasks at week end"
              categories={cats}
              columns={[{ label: "Overdue", values: data.weeks.map((w) => w.overdue) }]}
            />
          </Panel>
        </div>
      )}

      {data.approvals ? (
        <div className="grid two">
          <Panel title="Approval turnaround" action={<span className="eyebrow">median, hours</span>}>
            <LineChart
              categories={cats}
              series={[{ ...INK, label: "Median turnaround" }]}
              values={{ v: data.approvals.weeks.map((w) => w.medianHours) }}
              format={hours}
              ariaLabel="Median hours from submission to decision, per week"
              emptyNote="No decisions in the last 8 weeks"
            />
            <p className="definition">
              {data.definitions.turnaround} Weeks without decisions are left as gaps. {data.approvals.pending}{" "}
              pending now
              {data.approvals.pendingMedianAgeHours !== null
                ? `, median age ${hours(data.approvals.pendingMedianAgeHours)}`
                : ""}
              .
            </p>
            <ChartTable
              caption="Approval turnaround per week"
              categories={cats}
              columns={[
                { label: "Decided", values: data.approvals.weeks.map((w) => w.decided) },
                {
                  label: "Median turnaround",
                  values: data.approvals.weeks.map((w) => w.medianHours),
                  format: hours,
                },
              ]}
            />
          </Panel>
          {data.workflows ? (
            <Panel
              title="Workflow reliability"
              action={
                <Link to="/workflows" className="btn ghost sm">
                  Workflows
                </Link>
              }
            >
              {data.workflows.weeks.some((w) => w.succeeded || w.failed || w.inFlight) ? (
                <ChartTableAlwaysOpen
                  cats={cats}
                  rows={data.workflows.weeks.map((w) => [w.succeeded, w.failed, w.inFlight])}
                />
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  No workflow runs in the last 8 weeks.
                </p>
              )}
              <h3 style={{ marginTop: 16 }}>Failures in the last 30 days</h3>
              {data.workflows.failing.length === 0 ? (
                <p className="muted" style={{ margin: "6px 0 0" }}>
                  No workflow runs failed.
                </p>
              ) : (
                <ul className="list">
                  {data.workflows.failing.map((w) => (
                    <li key={w.id}>
                      <Link
                        to={`/workflows/${w.id}`}
                        className="list-item"
                        style={{ paddingLeft: 0, paddingRight: 0 }}
                      >
                        <span className="grow truncate">{w.name}</span>
                        <Badge tone="critical">✕ {w.failed} failed</Badge>
                        <span className="faint num" style={{ fontSize: 12 }}>
                          of {w.runs} runs
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <p className="definition">{data.definitions.workflowRuns}</p>
            </Panel>
          ) : null}
        </div>
      ) : null}

      <Panel title="Notable changes this week" flush>
        {data.notable.length === 0 ? (
          <EmptyState compact title="No new projects, people or project status changes in the last 7 days" />
        ) : (
          <ul className="list">
            {data.notable.map((e, i) => {
              const base = NOTABLE_LINK[e.entityType];
              const content = (
                <>
                  <span className="grow">{e.summary}</span>
                  <span className="faint" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                    {e.actorName ?? "System"} · {timeAgo(e.at)}
                  </span>
                </>
              );
              return (
                <li key={i}>
                  {base && e.entityId ? (
                    <Link to={`${base}${e.entityId}`} className="list-item">
                      {content}
                    </Link>
                  ) : (
                    <div className="list-item">{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      <p className="faint" style={{ fontSize: 12 }}>
        Weeks start Monday (UTC). Updated {timeAgo(data.generatedAt)}.
      </p>
    </div>
  );
}

/** Workflow run counts are small integers by status — a compact table reads better than a chart. */
function ChartTableAlwaysOpen({ cats, rows }: { cats: string[]; rows: number[][] }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Week</th>
            <th>✓ Succeeded</th>
            <th>✕ Failed</th>
            <th>Pending</th>
          </tr>
        </thead>
        <tbody>
          {cats.map((c, i) => (
            <tr key={c}>
              <td>{c}</td>
              <td className="num">{rows[i]![0]}</td>
              <td
                className="num"
                style={rows[i]![1] ? { color: "var(--critical)", fontWeight: 600 } : undefined}
              >
                {rows[i]![1]}
              </td>
              <td className="num muted">{rows[i]![2]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
