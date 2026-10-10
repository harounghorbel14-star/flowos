import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { TASK_STATUSES, label, type TaskStatus } from "@shared/domain";
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
import { dueLabel, formatDateTime, formatDay, personName, timeAgo } from "../lib/format";
import { useOrg } from "../lib/session";
import { errorCode, trpc } from "../lib/trpc";
import { NotFoundPage } from "./NotFound";

export function TaskDetailPage() {
  const { id = "" } = useParams();
  const { user, can } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [comment, setComment] = useState("");
  const [deletingComment, setDeletingComment] = useState<string | null>(null);
  const task = trpc.tasks.get.useQuery({ id });

  const refresh = () =>
    Promise.all([utils.tasks.invalidate(), utils.dashboard.invalidate(), utils.projects.invalidate()]);
  const setStatus = trpc.tasks.update.useMutation({ onSuccess: refresh, onError: toast.error });
  const remove = trpc.tasks.delete.useMutation({
    onSuccess: async () => {
      await refresh();
      toast.success("Task deleted.");
      navigate("/tasks");
    },
    onError: toast.error,
  });
  const addComment = trpc.tasks.addComment.useMutation({
    onSuccess: async () => {
      setComment("");
      await utils.tasks.get.invalidate({ id });
    },
    onError: toast.error,
  });
  const deleteComment = trpc.tasks.deleteComment.useMutation({
    onSuccess: async () => {
      await utils.tasks.get.invalidate({ id });
      setDeletingComment(null);
      toast.success("Comment deleted.");
    },
    onError: toast.error,
  });

  if (task.error && errorCode(task.error) === "NOT_FOUND") return <NotFoundPage what="task" />;
  if (task.error) return <ErrorState error={task.error} onRetry={() => void task.refetch()} />;
  if (!task.data) {
    return (
      <div className="panel">
        <SkeletonRows rows={6} />
      </div>
    );
  }
  const t = task.data;
  const due = t.status === "DONE" ? null : dueLabel(t.dueDate);
  const canDelete = can("task:write_any") || t.createdByUserId === user.id;

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <Link to="/tasks">Tasks</Link> / <span className="mono">{t.key}</span>
          </>
        }
        title={t.title}
        actions={
          <>
            {t.canEdit ? (
              <Button onClick={() => setEditing(true)}>
                <Pencil aria-hidden /> Edit
              </Button>
            ) : null}
            {canDelete ? (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                <Trash2 aria-hidden /> Delete
              </Button>
            ) : null}
          </>
        }
      />
      <div className="grid main-side">
        <div className="stack">
          <Panel title="Description">
            {t.description ? (
              <div className="prose">{t.description}</div>
            ) : (
              <span className="faint">No description.</span>
            )}
          </Panel>
          <Panel title={`Discussion (${t.comments.length})`}>
            <div className="stack" style={{ gap: 12 }}>
              {t.comments.length === 0 ? <span className="faint">No comments yet.</span> : null}
              {t.comments.map((c) => (
                <div key={c.id} className="comment">
                  <div className="spread" style={{ marginBottom: 4 }}>
                    <span className="row">
                      <Avatar name={c.authorName ?? "?"} />
                      <strong>{c.authorName ?? "Former member"}</strong>
                      <span className="faint" style={{ fontSize: 12 }} title={formatDateTime(c.createdAt)}>
                        {timeAgo(c.createdAt)}
                      </span>
                    </span>
                    {c.authorUserId === user.id || can("task:write_any") ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon
                        aria-label="Delete comment"
                        onClick={() => setDeletingComment(c.id)}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                  <div className="prose">{c.body}</div>
                </div>
              ))}
              {t.canComment ? (
                <form
                  className="form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (comment.trim()) addComment.mutate({ taskId: id, body: comment });
                  }}
                >
                  <label className="sr-only" htmlFor="new-comment">
                    Add a comment
                  </label>
                  <textarea
                    id="new-comment"
                    className="textarea"
                    rows={3}
                    placeholder="Add an update or ask a question…"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && comment.trim())
                        addComment.mutate({ taskId: id, body: comment });
                    }}
                  />
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    <span className="faint" style={{ fontSize: 12 }}>
                      Ctrl/⌘ + Enter
                    </span>
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      loading={addComment.isPending}
                      disabled={!comment.trim()}
                    >
                      Comment
                    </Button>
                  </div>
                </form>
              ) : null}
            </div>
          </Panel>
        </div>
        <div className="stack">
          <Panel title="Details">
            <dl className="facts">
              <dt>Status</dt>
              <dd>
                {t.canEdit ? (
                  <select
                    className="select"
                    style={{ height: 30 }}
                    aria-label="Status"
                    value={t.status}
                    disabled={setStatus.isPending}
                    onChange={(e) => setStatus.mutate({ id, status: e.target.value as TaskStatus })}
                  >
                    {TASK_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {label(s)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <StatusBadge value={t.status} />
                )}
              </dd>
              <dt>Priority</dt>
              <dd>
                <StatusBadge value={t.priority} dot={false} />
              </dd>
              <dt>Assignee</dt>
              <dd>
                {t.assigneeEmployeeId ? (
                  <Link to={`/people/${t.assigneeEmployeeId}`}>
                    {personName(t.assigneeFirstName, t.assigneeLastName)}
                  </Link>
                ) : (
                  <span className="faint">Unassigned</span>
                )}
              </dd>
              <dt>Project</dt>
              <dd>
                {t.projectId ? (
                  <Link to={`/projects/${t.projectId}`}>{t.projectName}</Link>
                ) : (
                  <span className="faint">None</span>
                )}
              </dd>
              <dt>Due</dt>
              <dd>
                {t.dueDate ? formatDay(t.dueDate) : <span className="faint">No due date</span>}
                {due && due.tone !== "none" && t.dueDate ? (
                  <span className={`badge ${due.tone}`} style={{ marginLeft: 8 }}>
                    {due.text}
                  </span>
                ) : null}
              </dd>
              <dt>Created</dt>
              <dd title={formatDateTime(t.createdAt)}>
                {timeAgo(t.createdAt)}
                {t.createdByName ? ` by ${t.createdByName}` : ""}
              </dd>
              {t.completedAt ? (
                <>
                  <dt>Completed</dt>
                  <dd>{formatDateTime(t.completedAt)}</dd>
                </>
              ) : null}
            </dl>
          </Panel>
          <Panel title="Activity">
            {t.history.length === 0 ? (
              <EmptyState compact title="No activity" />
            ) : (
              <ol className="timeline">
                {t.history.map((h) => (
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

      <TaskFormDialog
        open={editing}
        onClose={() => setEditing(false)}
        initial={{
          id: t.id,
          title: t.title,
          description: t.description ?? "",
          status: t.status,
          priority: t.priority,
          projectId: t.projectId ?? "",
          assigneeEmployeeId: t.assigneeEmployeeId ?? "",
          dueDate: t.dueDate ?? "",
        }}
      />
      <ConfirmDialog
        open={deletingComment !== null}
        onClose={() => setDeletingComment(null)}
        title="Delete this comment?"
        body="The comment is removed from the discussion for everyone. This cannot be undone."
        confirmLabel="Delete comment"
        danger
        loading={deleteComment.isPending}
        onConfirm={() => deletingComment && deleteComment.mutate({ commentId: deletingComment })}
      />
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this task?"
        body={
          <>
            <strong>{t.title}</strong> and its comments will be permanently removed. The audit log keeps a
            record that it existed.
          </>
        }
        confirmLabel="Delete task"
        danger
        loading={remove.isPending}
        onConfirm={() => remove.mutate({ id })}
      />
    </>
  );
}
