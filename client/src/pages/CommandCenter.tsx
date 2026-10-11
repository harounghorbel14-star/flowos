import { ArrowRight, CalendarClock, CheckSquare, FolderKanban, Plus, Stamp, Users } from "lucide-react";
import { Link } from "react-router-dom";
import { label } from "@shared/domain";
import {
  Avatar,
  Badge,
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  SkeletonRows,
  StatusBadge,
} from "../components/ui";
import { dueLabel, formatDay, percent, personName, timeAgo } from "../lib/format";
import { useCountUp } from "../lib/motion";
import { useOrg } from "../lib/session";
import { trpc } from "../lib/trpc";

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

const ACTIVITY_LINK: Record<string, string> = {
  task: "/tasks/",
  project: "/projects/",
  employee: "/people/",
  approval: "/approvals/",
};

export function CommandCenterPage() {
  const { user, org, can } = useOrg();
  const cc = trpc.dashboard.commandCenter.useQuery(undefined, { refetchInterval: 60_000 });
  const today = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(
    new Date(),
  );

  return (
    <>
      <PageHeader
        eyebrow={`${org.name} · ${today}`}
        title={`${greeting()}, ${user.name.split(" ")[0]}.`}
        lede="What needs your attention, why it matters, and what should happen next."
        actions={
          <>
            {can("task:create") ? (
              <Link className="btn primary" to="/tasks?new=1">
                <Plus aria-hidden /> New task
              </Link>
            ) : null}
            {can("approval:create") ? (
              <Link className="btn" to="/approvals?new=1">
                <Stamp aria-hidden /> Request approval
              </Link>
            ) : null}
          </>
        }
      />

      {cc.error ? <ErrorState error={cc.error} onRetry={() => void cc.refetch()} /> : null}
      {cc.isLoading ? (
        <div className="stack" aria-busy="true" aria-label="Loading">
          <MetricsSkeleton />
          <div className="panel">
            <SkeletonRows rows={5} />
          </div>
        </div>
      ) : null}

      {cc.data ? (
        <div className="stack">
          {cc.data.totals.tasks === 0 && cc.data.totals.projects === 0 ? (
            <GettingStarted totals={cc.data.totals} />
          ) : null}

          <div className="metrics" aria-label="Key measures">
            <Metric
              to="/tasks?view=mine"
              label="My open tasks"
              value={cc.data.metrics.myOpenTasks}
              hint={
                cc.data.hasEmployeeProfile ? `${cc.data.metrics.myOverdueTasks} overdue` : "No linked profile"
              }
              tone={cc.data.metrics.myOverdueTasks > 0 ? "critical" : undefined}
            />
            <Metric
              to="/approvals"
              label="Awaiting my decision"
              value={cc.data.metrics.approvalsAwaitingMe}
              hint={`${cc.data.metrics.myOpenRequests} of my requests pending`}
              tone={cc.data.metrics.approvalsAwaitingMe > 0 ? "attention" : undefined}
            />
            <Metric
              to="/tasks?overdue=1"
              label="Overdue tasks"
              value={cc.data.metrics.overdueTasks}
              hint={`of ${cc.data.metrics.openTasks} open across the org`}
              tone={cc.data.metrics.overdueTasks > 0 ? "critical" : undefined}
            />
            <Metric
              to="/projects"
              label="Projects at risk"
              value={cc.data.metrics.projectsAtRisk}
              hint={`${cc.data.metrics.completedLast7Days} ${cc.data.metrics.completedLast7Days === 1 ? "task" : "tasks"} done in 7 days`}
              tone={cc.data.metrics.projectsAtRisk > 0 ? "attention" : undefined}
            />
          </div>

          <div className="grid main-side">
            <div className="stack">
              <Panel
                title="Briefing"
                action={
                  <span
                    className="eyebrow"
                    title="Generated from live counts by fixed rules. No AI is involved."
                  >
                    Rule-based · live data
                  </span>
                }
                flush
              >
                {cc.data.briefing.length === 0 ? (
                  <EmptyState compact title="Nothing needs attention right now">
                    No overdue or blocked work, no pending decisions. The briefing fills in as your team works
                    in FLOWOS.
                  </EmptyState>
                ) : (
                  <ul className="briefing">
                    {cc.data.briefing.map((line, i) => (
                      <li key={i} className={`tone-${line.tone}`}>
                        <span className="dot" aria-hidden />
                        <span>{line.text}</span>
                        {line.link ? (
                          <Link to={line.link} className="btn ghost sm" aria-label={`Open: ${line.text}`}>
                            <ArrowRight aria-hidden />
                          </Link>
                        ) : (
                          <span />
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              <Panel
                title="My work"
                action={
                  <Link to="/tasks?view=mine" className="btn ghost sm">
                    All my tasks
                  </Link>
                }
                flush
              >
                {cc.data.myTasks.length === 0 ? (
                  <EmptyState
                    compact
                    icon={<CheckSquare size={18} />}
                    title={
                      cc.data.hasEmployeeProfile
                        ? "No open tasks assigned to you"
                        : "No directory profile linked"
                    }
                  >
                    {cc.data.hasEmployeeProfile
                      ? "When someone assigns you work it shows up here, ordered by due date."
                      : "Ask an admin to link your account to your profile in People so work can be assigned to you."}
                  </EmptyState>
                ) : (
                  <ul className="list">
                    {cc.data.myTasks.map((t) => {
                      const due = dueLabel(t.dueDate);
                      return (
                        <li key={t.id}>
                          <Link to={`/tasks/${t.id}`} className="list-item">
                            <span className="key">#{t.number}</span>
                            <span className="grow truncate">{t.title}</span>
                            {t.priority === "URGENT" || t.priority === "HIGH" ? (
                              <StatusBadge value={t.priority} dot={false} />
                            ) : null}
                            <span
                              className={
                                due.tone === "critical"
                                  ? "badge critical"
                                  : due.tone === "attention"
                                    ? "badge attention"
                                    : "faint num hide-sm"
                              }
                              style={{ fontSize: 12 }}
                            >
                              {due.text}
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Panel>

              <Panel
                title="Projects at risk"
                action={
                  <Link to="/projects" className="btn ghost sm">
                    All projects
                  </Link>
                }
                flush
              >
                {cc.data.projectsAtRisk.length === 0 ? (
                  <EmptyState compact icon={<FolderKanban size={18} />} title="No projects flagged">
                    A project is flagged when it is past due, has overdue or blocked tasks, or is due within 7
                    days with under 70% of tasks done.
                  </EmptyState>
                ) : (
                  <ul className="list">
                    {cc.data.projectsAtRisk.map((p) => (
                      <li key={p.id}>
                        <Link
                          to={`/projects/${p.id}`}
                          className="list-item"
                          style={{ alignItems: "flex-start" }}
                        >
                          <div className="grow">
                            <div className="spread">
                              <strong className="truncate">{p.name}</strong>
                              <span className="faint num" style={{ fontSize: 12 }}>
                                {p.totalTasks ? `${percent(p.progress)} done` : "No tasks"}
                              </span>
                            </div>
                            <div className="faint" style={{ fontSize: 12.5, marginTop: 2 }}>
                              {p.reasons.join(" · ")}
                            </div>
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>

            <div className="stack">
              <Panel title="Decisions waiting on you" flush>
                {cc.data.approvals.length === 0 ? (
                  <EmptyState compact icon={<Stamp size={18} />} title="Inbox zero">
                    No approval requests are waiting for you.
                  </EmptyState>
                ) : (
                  <ul className="list">
                    {cc.data.approvals.map((a) => (
                      <li key={a.id}>
                        <Link to={`/approvals/${a.id}`} className="list-item">
                          <Avatar name={a.requesterName} />
                          <div className="grow">
                            <div className="truncate">{a.title}</div>
                            <div className="faint" style={{ fontSize: 12 }}>
                              {label(a.type)} · {a.requesterName} · {timeAgo(a.createdAt)}
                            </div>
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              <Panel title="Next 7 days" flush>
                {cc.data.deadlines.length === 0 ? (
                  <EmptyState compact icon={<CalendarClock size={18} />} title="No upcoming deadlines">
                    Open tasks due this week, or already overdue, appear here.
                  </EmptyState>
                ) : (
                  <ul className="list">
                    {cc.data.deadlines.map((t) => {
                      const due = dueLabel(t.dueDate);
                      return (
                        <li key={t.id}>
                          <Link to={`/tasks/${t.id}`} className="list-item">
                            <div className="grow">
                              <div className="truncate">{t.title}</div>
                              <div className="faint" style={{ fontSize: 12 }}>
                                {t.assigneeFirstName
                                  ? personName(t.assigneeFirstName, t.assigneeLastName)
                                  : "Unassigned"}{" "}
                                · {formatDay(t.dueDate)}
                              </div>
                            </div>
                            <Badge tone={due.tone === "none" ? undefined : due.tone}>{due.text}</Badge>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Panel>

              {cc.data.expiringDocuments.length > 0 ? (
                <Panel
                  title="Documents needing attention"
                  action={
                    <Link to="/documents?expiring=1" className="btn ghost sm">
                      All
                    </Link>
                  }
                  flush
                >
                  <ul className="list">
                    {cc.data.expiringDocuments.map((d) => {
                      const expired = d.expiresOn < cc.data.today;
                      return (
                        <li key={d.id}>
                          <Link to={`/documents?q=${encodeURIComponent(d.title)}`} className="list-item">
                            <span className="grow truncate">{d.title}</span>
                            <Badge tone={expired ? "critical" : "attention"}>
                              {expired ? "Expired" : "Expires"} {formatDay(d.expiresOn)}
                            </Badge>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </Panel>
              ) : null}

              {cc.data.onLeaveToday.length > 0 ? (
                <Panel title="On approved leave today" flush>
                  <ul className="list">
                    {cc.data.onLeaveToday.map((l) => (
                      <li key={l.id} className="list-item">
                        <Avatar name={l.name} />
                        <span className="grow">{l.name}</span>
                        <span className="faint" style={{ fontSize: 12 }}>
                          until {formatDay(l.endDate)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Panel>
              ) : null}

              <Panel title="Recent activity" flush>
                {cc.data.activity.length === 0 ? (
                  <EmptyState compact title="No activity yet" />
                ) : (
                  <ul className="list">
                    {cc.data.activity.map((a) => {
                      const base = ACTIVITY_LINK[a.entityType];
                      const body = (
                        <>
                          <div className="grow">
                            <div className="truncate" style={{ fontSize: 13 }}>
                              {a.summary}
                            </div>
                            <div className="faint" style={{ fontSize: 12 }}>
                              {a.actorName ?? "System"} · {timeAgo(a.createdAt)}
                            </div>
                          </div>
                        </>
                      );
                      return (
                        <li key={a.id}>
                          {base && a.entityId ? (
                            <Link to={`${base}${a.entityId}`} className="list-item">
                              {body}
                            </Link>
                          ) : (
                            <div className="list-item">{body}</div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Panel>
            </div>
          </div>
          <p className="faint" style={{ fontSize: 12 }}>
            Updated {timeAgo(cc.data.generatedAt)} · every figure is a live count of this organization’s
            records.
          </p>
        </div>
      ) : null}
    </>
  );
}

function Metric({
  to,
  label: text,
  value,
  hint,
  tone,
}: {
  to: string;
  label: string;
  value: number;
  hint: string;
  tone?: "critical" | "attention";
}) {
  const shown = useCountUp(value, `cc:${to}`);
  return (
    <Link to={to} className={["metric", tone].filter(Boolean).join(" ")}>
      <span className="eyebrow">{text}</span>
      {/* Assistive technology reads the real value, never the in-between frames. */}
      <span className="value" aria-hidden>
        {shown}
      </span>
      <span className="sr-only">{value}</span>
      <span className="hint">{hint}</span>
    </Link>
  );
}

/** Same grid and heights as the loaded metrics, so nothing jumps when data arrives. */
function MetricsSkeleton() {
  return (
    <div className="metrics" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="metric">
          <span className="skeleton" style={{ width: "55%", height: 11 }} />
          <span className="skeleton" style={{ width: 44, height: 32, margin: "2px 0" }} />
          <span className="skeleton" style={{ width: "70%", height: 11 }} />
        </div>
      ))}
    </div>
  );
}

function GettingStarted({ totals }: { totals: { employees: number; projects: number; tasks: number } }) {
  const { can } = useOrg();
  const steps = [
    {
      done: totals.employees > 1,
      title: "Add your people",
      body: "Build the directory so work can be assigned.",
      to: "/people?new=1",
      allowed: can("employee:write"),
    },
    {
      done: false,
      title: "Invite your team",
      body: "Send single-use invitation links.",
      to: "/settings/members",
      allowed: can("member:manage"),
    },
    {
      done: totals.projects > 0,
      title: "Start a project",
      body: "Group related work and track real progress.",
      to: "/projects?new=1",
      allowed: can("project:write"),
    },
    {
      done: totals.tasks > 0,
      title: "Create the first task",
      body: "Assign it, set a due date, and watch it here.",
      to: "/tasks?new=1",
      allowed: can("task:create"),
    },
  ].filter((s) => s.allowed);
  if (steps.length === 0) return null;
  return (
    <Panel title="Set up your workspace" action={<span className="eyebrow">No business data yet</span>}>
      <div className="grid two">
        {steps.map((s) => (
          <Link key={s.title} to={s.to} className="list-item panel" style={{ boxShadow: "none" }}>
            <span className="avatar" aria-hidden>
              {s.done ? "✓" : <Users size={13} />}
            </span>
            <span className="grow">
              <strong>{s.title}</strong>
              <div className="faint" style={{ fontSize: 12.5 }}>
                {s.body}
              </div>
            </span>
            <ArrowRight size={15} aria-hidden className="faint" />
          </Link>
        ))}
      </div>
    </Panel>
  );
}
