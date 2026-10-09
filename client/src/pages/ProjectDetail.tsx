import { AlertTriangle, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { TASK_STATUSES, label } from "@shared/domain";
import { ProjectFormDialog } from "../components/forms/ProjectForm";
import { TaskFormDialog } from "../components/forms/TaskForm";
import { useToast } from "../components/toast";
import {
  Avatar,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  SkeletonRows,
  StatusBadge,
} from "../components/ui";
import { dueLabel, formatDateTime, formatDay, percent, personName, timeAgo } from "../lib/format";
import { useOrg } from "../lib/session";
import { errorCode, trpc } from "../lib/trpc";
import { NotFoundPage } from "./NotFound";

export function ProjectDetailPage() {
  const { id = "" } = useParams();
  const { org, can } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const project = trpc.projects.get.useQuery({ id });
  const tasks = trpc.tasks.list.useQuery({ projectId: id, pageSize: 100, sort: "priority" });
  const remove = trpc.projects.delete.useMutation({
    onSuccess: async () => {
      await utils.projects.invalidate();
      toast.success("Project deleted.");
      navigate("/projects");
    },
    onError: toast.error,
  });

  if (project.error && errorCode(project.error) === "NOT_FOUND") return <NotFoundPage what="project" />;
  if (project.error) return <ErrorState error={project.error} onRetry={() => void project.refetch()} />;
  if (!project.data) {
    return (
      <div className="panel">
        <SkeletonRows rows={6} />
      </div>
    );
  }
  const p = project.data;
  const byStatus = new Map(
    TASK_STATUSES.map((s) => [s, (tasks.data?.items ?? []).filter((t) => t.status === s)]),
  );

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <Link to="/projects">Projects</Link> / {label(p.status)}
          </>
        }
        title={p.name}
        lede={p.description ?? undefined}
        actions={
          <>
            {can("task:create") && p.status !== "CANCELLED" ? (
              <Button variant="primary" onClick={() => setAddingTask(true)}>
                <Plus aria-hidden /> Add task
              </Button>
            ) : null}
            {can("project:write") ? (
              <Button onClick={() => setEditing(true)}>
                <Pencil aria-hidden /> Edit
              </Button>
            ) : null}
            {can("project:write") && p.stats.total === 0 ? (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                <Trash2 aria-hidden /> Delete
              </Button>
            ) : null}
          </>
        }
      />
      <div className="stack">
        <div className="metrics">
          <div className="metric">
            <span className="eyebrow">Progress</span>
            <span className="value">{p.stats.total ? percent(p.stats.progress) : "—"}</span>
            <span className="hint">
              {p.stats.done} of {p.stats.total} tasks done
            </span>
          </div>
          <div className={p.stats.overdue ? "metric critical" : "metric"}>
            <span className="eyebrow">Overdue tasks</span>
            <span className="value">{p.stats.overdue}</span>
            <span className="hint">open with a past due date</span>
          </div>
          <div className={p.stats.blocked ? "metric attention" : "metric"}>
            <span className="eyebrow">Blocked</span>
            <span className="value">{p.stats.blocked}</span>
            <span className="hint">tasks marked blocked</span>
          </div>
          <div className="metric">
            <span className="eyebrow">Due</span>
            <span className="value" style={{ fontSize: 24 }}>
              {formatDay(p.dueDate)}
            </span>
            <span className="hint">
              {p.dueDate && p.status !== "COMPLETED"
                ? dueLabel(p.dueDate).text
                : p.completedAt
                  ? `Completed ${timeAgo(p.completedAt)}`
                  : "No due date"}
            </span>
          </div>
        </div>

        {p.risk.length ? (
          <div
            className="panel panel-body"
            style={{ borderColor: "color-mix(in srgb, var(--attention) 40%, var(--line))" }}
          >
            <div className="row" style={{ color: "var(--attention)", marginBottom: 6 }}>
              <AlertTriangle size={16} aria-hidden /> <strong>At risk — measured facts</strong>
            </div>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {p.risk.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <Panel
          title="Board"
          action={
            <Link className="btn ghost sm" to={`/tasks?project=${p.id}`}>
              Open as list
            </Link>
          }
        >
          {tasks.isLoading ? <SkeletonRows rows={3} /> : null}
          {tasks.data && tasks.data.total === 0 ? (
            <EmptyState compact title="No tasks in this project">
              Add the first task to start tracking progress.
            </EmptyState>
          ) : null}
          {tasks.data && tasks.data.total > 0 ? (
            <div className="board">
              {TASK_STATUSES.map((s) => (
                <div key={s} className="board-col" aria-label={label(s)}>
                  <div className="spread">
                    <StatusBadge value={s} />
                    <span className="faint num" style={{ fontSize: 12 }}>
                      {byStatus.get(s)!.length}
                    </span>
                  </div>
                  {byStatus.get(s)!.map((t) => {
                    const due = t.status === "DONE" ? null : dueLabel(t.dueDate);
                    return (
                      <Link key={t.id} to={`/tasks/${t.id}`} className="board-card">
                        <span className="key">
                          {org.taskPrefix}-{t.number}
                        </span>
                        <span style={{ fontWeight: 500 }}>{t.title}</span>
                        <span className="spread">
                          <span className="faint" style={{ fontSize: 12 }}>
                            {t.assigneeEmployeeId
                              ? personName(t.assigneeFirstName, t.assigneeLastName)
                              : "Unassigned"}
                          </span>
                          {due && t.dueDate ? (
                            <span
                              className={due.tone === "none" ? "faint" : `badge ${due.tone}`}
                              style={{ fontSize: 11.5 }}
                            >
                              {due.text}
                            </span>
                          ) : null}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              ))}
            </div>
          ) : null}
          {tasks.data && tasks.data.total > 100 ? (
            <p className="faint">Showing the first 100 tasks. Open as list to see all.</p>
          ) : null}
        </Panel>

        <div className="grid two">
          <Panel title="Team" flush>
            {p.members.length === 0 && !p.ownerEmployeeId ? (
              <EmptyState compact title="No one assigned">
                Set an owner and team members from Edit.
              </EmptyState>
            ) : (
              <ul className="list">
                {p.ownerEmployeeId ? (
                  <li>
                    <Link to={`/people/${p.ownerEmployeeId}`} className="list-item">
                      <Avatar name={personName(p.ownerFirstName, p.ownerLastName)} />
                      <span className="grow">{personName(p.ownerFirstName, p.ownerLastName)}</span>
                      <span className="badge teal">Owner</span>
                    </Link>
                  </li>
                ) : null}
                {p.members
                  .filter((m) => m.id !== p.ownerEmployeeId)
                  .map((m) => (
                    <li key={m.id}>
                      <Link to={`/people/${m.id}`} className="list-item">
                        <Avatar name={personName(m.firstName, m.lastName)} />
                        <span className="grow">{personName(m.firstName, m.lastName)}</span>
                        <span className="faint" style={{ fontSize: 12 }}>
                          {m.jobTitle}
                        </span>
                      </Link>
                    </li>
                  ))}
              </ul>
            )}
          </Panel>
          <Panel title="History">
            {p.history.length === 0 ? (
              <span className="faint">No history.</span>
            ) : (
              <ol className="timeline">
                {p.history.map((h) => (
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
      </div>

      <ProjectFormDialog
        open={editing}
        onClose={() => setEditing(false)}
        initial={{
          id: p.id,
          name: p.name,
          description: p.description ?? "",
          status: p.status,
          ownerEmployeeId: p.ownerEmployeeId ?? "",
          startDate: p.startDate ?? "",
          dueDate: p.dueDate ?? "",
          memberIds: p.members.map((m) => m.id),
        }}
      />
      <TaskFormDialog open={addingTask} onClose={() => setAddingTask(false)} initial={{ projectId: p.id }} />
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this project?"
        body="The project has no tasks, so nothing else is affected. This cannot be undone."
        confirmLabel="Delete project"
        danger
        loading={remove.isPending}
        onConfirm={() => remove.mutate({ id })}
      />
    </>
  );
}
