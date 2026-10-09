import { Pencil } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { label } from "@shared/domain";
import { EmployeeFormDialog } from "../components/forms/EmployeeForm";
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  SkeletonRows,
  StatusBadge,
} from "../components/ui";
import { formatDateTime, formatDay, personName, timeAgo } from "../lib/format";
import { useOrg } from "../lib/session";
import { errorCode, trpc } from "../lib/trpc";
import { NotFoundPage } from "./NotFound";

export function EmployeeDetailPage() {
  const { id = "" } = useParams();
  const { can } = useOrg();
  const [editing, setEditing] = useState(false);
  const employee = trpc.employees.get.useQuery({ id });
  const tasks = trpc.tasks.list.useQuery({
    assigneeEmployeeId: id,
    statuses: ["TODO", "IN_PROGRESS", "BLOCKED", "REVIEW"],
    sort: "due",
    pageSize: 10,
  });

  if (employee.error && errorCode(employee.error) === "NOT_FOUND") return <NotFoundPage what="person" />;
  if (employee.error) return <ErrorState error={employee.error} onRetry={() => void employee.refetch()} />;
  if (!employee.data) {
    return (
      <div className="panel">
        <SkeletonRows rows={6} />
      </div>
    );
  }
  const e = employee.data;
  const name = personName(e.firstName, e.lastName);

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <Link to="/people">People</Link> / {e.departmentName ?? "No department"}
          </>
        }
        title={
          <span className="row" style={{ gap: 14 }}>
            <Avatar name={name} large /> {name}
          </span>
        }
        lede={e.jobTitle ?? undefined}
        actions={
          can("employee:write") ? (
            <Button onClick={() => setEditing(true)}>
              <Pencil aria-hidden /> Edit profile
            </Button>
          ) : null
        }
      />
      <div className="grid main-side">
        <div className="stack">
          <div className="metrics" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
            <div className="metric">
              <span className="eyebrow">Open tasks</span>
              <span className="value">{e.taskStats.open}</span>
              <span className="hint">assigned and not done</span>
            </div>
            <div className={e.taskStats.overdue ? "metric critical" : "metric"}>
              <span className="eyebrow">Overdue</span>
              <span className="value">{e.taskStats.overdue}</span>
              <span className="hint">past their due date</span>
            </div>
            <div className="metric">
              <span className="eyebrow">Completed</span>
              <span className="value">{e.taskStats.done}</span>
              <span className="hint">all time</span>
            </div>
          </div>
          <Panel title="Current work" flush>
            {tasks.data && tasks.data.items.length === 0 ? (
              <EmptyState compact title="No open tasks" />
            ) : (
              <ul className="list">
                {(tasks.data?.items ?? []).map((t) => (
                  <li key={t.id}>
                    <Link to={`/tasks/${t.id}`} className="list-item">
                      <span className="key">#{t.number}</span>
                      <span className="grow truncate">{t.title}</span>
                      <StatusBadge value={t.status} />
                      <span className="faint num hide-sm" style={{ fontSize: 12 }}>
                        {formatDay(t.dueDate)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Profile history">
            {e.history.length === 0 ? (
              <span className="faint">No history.</span>
            ) : (
              <ol className="timeline">
                {e.history.map((h) => (
                  <li key={h.id}>
                    <div style={{ fontSize: 13 }}>{h.summary}</div>
                    <div className="faint" style={{ fontSize: 12 }} title={formatDateTime(h.createdAt)}>
                      {h.actorName ?? "System"} · {timeAgo(h.createdAt)}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>
        <div className="stack">
          <Panel title="Details">
            <dl className="facts">
              <dt>Status</dt>
              <dd>
                <StatusBadge value={e.status} />
              </dd>
              <dt>Type</dt>
              <dd>{label(e.employmentType)}</dd>
              <dt>Email</dt>
              <dd className="truncate">
                <a href={`mailto:${e.email}`}>{e.email}</a>
              </dd>
              <dt>Phone</dt>
              <dd>{e.phone ?? <span className="faint">—</span>}</dd>
              <dt>Location</dt>
              <dd>{e.location ?? <span className="faint">—</span>}</dd>
              <dt>Department</dt>
              <dd>
                {e.departmentId ? (
                  <Link to={`/people?department=${e.departmentId}`}>{e.departmentName}</Link>
                ) : (
                  <span className="faint">—</span>
                )}
              </dd>
              <dt>Manager</dt>
              <dd>
                {e.managerId ? (
                  <Link to={`/people/${e.managerId}`}>
                    {personName(e.managerFirstName, e.managerLastName)}
                  </Link>
                ) : (
                  <span className="faint">—</span>
                )}
              </dd>
              <dt>Started</dt>
              <dd>{formatDay(e.startDate)}</dd>
              {e.endDate ? (
                <>
                  <dt>Ends</dt>
                  <dd>{formatDay(e.endDate)}</dd>
                </>
              ) : null}
              <dt>Account</dt>
              <dd>
                {e.userId ? (
                  <Badge tone="teal">Linked · {e.accountName}</Badge>
                ) : (
                  <span className="faint">Not linked</span>
                )}
              </dd>
            </dl>
          </Panel>
          <Panel title={`Direct reports (${e.directReports.length})`} flush>
            {e.directReports.length === 0 ? (
              <EmptyState compact title="No direct reports" />
            ) : (
              <ul className="list">
                {e.directReports.map((r) => (
                  <li key={r.id}>
                    <Link to={`/people/${r.id}`} className="list-item">
                      <Avatar name={personName(r.firstName, r.lastName)} />
                      <span className="grow">{personName(r.firstName, r.lastName)}</span>
                      <span className="faint" style={{ fontSize: 12 }}>
                        {r.jobTitle}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
      <EmployeeFormDialog
        open={editing}
        onClose={() => setEditing(false)}
        initial={{
          id: e.id,
          firstName: e.firstName,
          lastName: e.lastName,
          email: e.email,
          jobTitle: e.jobTitle ?? "",
          phone: e.phone ?? "",
          location: e.location ?? "",
          departmentId: e.departmentId ?? "",
          managerId: e.managerId ?? "",
          userId: e.userId ?? "",
          status: e.status,
          employmentType: e.employmentType,
          startDate: e.startDate ?? "",
          endDate: e.endDate ?? "",
        }}
      />
    </>
  );
}
