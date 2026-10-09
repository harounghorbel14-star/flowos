import { Pencil, Plus, RotateCw, Sparkles, Trash2, Workflow } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { label } from "@shared/domain";
import {
  ACTION_LABELS,
  ASSIGNEE_LABELS,
  OP_LABELS,
  ONBOARDING_TEMPLATE,
  RECIPIENT_LABELS,
  TRIGGERS,
  type TriggerType,
  type WorkflowAction,
} from "@shared/workflows";
import { WorkflowFormDialog } from "../components/forms/WorkflowForm";
import { useToast } from "../components/toast";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  Panel,
  SkeletonRows,
} from "../components/ui";
import { formatDateTime, timeAgo } from "../lib/format";
import { useOrg } from "../lib/session";
import { errorCode, trpc } from "../lib/trpc";
import { NotFoundPage } from "./NotFound";
import { integrationById } from "@shared/integrations";

const RUN_TONE: Record<string, string> = {
  SUCCEEDED: "good",
  FAILED: "critical",
  PENDING: "attention",
  RUNNING: "info",
};
const RUN_LABEL: Record<string, string> = {
  SUCCEEDED: "Succeeded",
  FAILED: "Failed",
  PENDING: "Waiting to retry",
  RUNNING: "Running",
};

function fieldLabel(trigger: TriggerType, key: string) {
  return TRIGGERS[trigger]?.fields.find((f) => f.key === key)?.label ?? key;
}

function describeAction(a: WorkflowAction): string {
  if (a.type === "create_task") {
    const due =
      a.dueInDays === null ? "no due date" : `due in ${a.dueInDays} day${a.dueInDays === 1 ? "" : "s"}`;
    return `Create “${a.title}” · ${label(a.priority)} · ${due} · ${ASSIGNEE_LABELS[a.assignee].toLowerCase()}`;
  }
  if (a.type === "send_message") {
    return `Post to ${integrationById(a.provider)?.name ?? a.provider}: “${a.text.length > 60 ? `${a.text.slice(0, 59)}…` : a.text}”`;
  }
  return `Notify ${RECIPIENT_LABELS[a.recipient].toLowerCase()}: “${a.title}”`;
}

export function WorkflowsPage() {
  const { can } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const utils = trpc.useUtils();
  const list = trpc.workflows.list.useQuery();
  const [creating, setCreating] = useState<"blank" | "template" | null>(null);
  const toggle = trpc.workflows.update.useMutation({
    onSuccess: async (w) => {
      await utils.workflows.invalidate();
      toast.success(w.enabled ? "Workflow enabled." : "Workflow paused.");
    },
    onError: toast.error,
  });

  return (
    <>
      <PageHeader
        eyebrow="Automate"
        title="Workflows"
        lede="When something happens, if conditions match, then FLOWOS does the follow-up work — with a full run history."
        actions={
          can("workflow:manage") ? (
            <>
              <Button onClick={() => setCreating("template")}>
                <Sparkles aria-hidden /> Onboarding template
              </Button>
              <Button variant="primary" onClick={() => setCreating("blank")}>
                <Plus aria-hidden /> New workflow
              </Button>
            </>
          ) : null
        }
      />
      {list.error ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
      {list.isLoading ? (
        <div className="panel">
          <SkeletonRows />
        </div>
      ) : null}
      {list.data && list.data.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon={<Workflow size={18} />}
            title="No workflows yet"
            action={
              can("workflow:manage") ? (
                <Button variant="primary" onClick={() => setCreating("template")}>
                  <Sparkles aria-hidden /> Start from the onboarding template
                </Button>
              ) : null
            }
          >
            Automate repeatable follow-ups: onboarding tasks when someone joins, alerts when work is blocked,
            next steps when a request is approved.
          </EmptyState>
        </div>
      ) : null}
      {list.data && list.data.length > 0 ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Workflow</th>
                <th className="hide-sm">When</th>
                <th>Last 7 days</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((w) => (
                <tr key={w.id}>
                  <td style={{ minWidth: 200 }}>
                    <Link className="row-link" to={`/workflows/${w.id}`}>
                      {w.name}
                    </Link>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {w.actionCount} action{w.actionCount === 1 ? "" : "s"} · runs as{" "}
                      {w.ownerName ?? "nobody"}
                    </div>
                  </td>
                  <td className="hide-sm muted">{TRIGGERS[w.trigger as TriggerType]?.label ?? w.trigger}</td>
                  <td>
                    <span className="row" style={{ gap: 6 }}>
                      <Badge tone="good">{w.last7Days.succeeded} ok</Badge>
                      {w.last7Days.failed ? <Badge tone="critical">{w.last7Days.failed} failed</Badge> : null}
                      {w.last7Days.inFlight ? (
                        <Badge tone="attention">{w.last7Days.inFlight} pending</Badge>
                      ) : null}
                    </span>
                  </td>
                  <td>
                    {can("workflow:manage") ? (
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={w.enabled}
                          disabled={toggle.isPending && toggle.variables?.id === w.id}
                          onChange={(e) => toggle.mutate({ id: w.id, enabled: e.target.checked })}
                        />
                        {w.enabled ? "On" : "Paused"}
                        <span className="sr-only"> — {w.name}</span>
                      </label>
                    ) : (
                      <Badge tone={w.enabled ? "teal" : undefined}>{w.enabled ? "On" : "Paused"}</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <WorkflowFormDialog
        open={creating !== null}
        onClose={() => setCreating(null)}
        initial={
          creating === "template"
            ? {
                name: ONBOARDING_TEMPLATE.name,
                description: ONBOARDING_TEMPLATE.description,
                trigger: ONBOARDING_TEMPLATE.trigger,
                conditions: ONBOARDING_TEMPLATE.conditions,
                actions: ONBOARDING_TEMPLATE.actions,
              }
            : undefined
        }
        onSaved={(id) => navigate(`/workflows/${id}`)}
      />
    </>
  );
}

export function WorkflowDetailPage() {
  const { id = "" } = useParams();
  const { can } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const utils = trpc.useUtils();
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const wf = trpc.workflows.get.useQuery({ id });
  const runs = trpc.workflows.runs.useQuery(
    { workflowId: id, page, pageSize: 20 },
    { enabled: wf.isSuccess, refetchInterval: 5000 },
  );
  const retry = trpc.workflows.retryRun.useMutation({
    onSuccess: async () => {
      await utils.workflows.invalidate();
      toast.success("Run queued for retry. Steps that already succeeded will not repeat.");
    },
    onError: toast.error,
  });
  const remove = trpc.workflows.delete.useMutation({
    onSuccess: async () => {
      await utils.workflows.invalidate();
      toast.success("Workflow deleted.");
      navigate("/workflows");
    },
    onError: toast.error,
  });

  if (wf.error && errorCode(wf.error) === "NOT_FOUND") return <NotFoundPage what="workflow" />;
  if (wf.error) return <ErrorState error={wf.error} onRetry={() => void wf.refetch()} />;
  if (!wf.data) {
    return (
      <div className="panel">
        <SkeletonRows rows={6} />
      </div>
    );
  }
  const w = wf.data;
  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <Link to="/workflows">Workflows</Link> / {w.enabled ? "On" : "Paused"}
          </>
        }
        title={w.name}
        lede={w.description ?? undefined}
        actions={
          can("workflow:manage") ? (
            <>
              <Button onClick={() => setEditing(true)}>
                <Pencil aria-hidden /> Edit
              </Button>
              <Button variant="danger" onClick={() => setDeleting(true)}>
                <Trash2 aria-hidden /> Delete
              </Button>
            </>
          ) : null
        }
      />
      <div className="grid main-side">
        <Panel title="Run history" flush>
          {runs.error ? <ErrorState error={runs.error} onRetry={() => void runs.refetch()} /> : null}
          {runs.isLoading ? <SkeletonRows rows={3} /> : null}
          {runs.data && runs.data.total === 0 ? (
            <EmptyState compact title="No runs yet">
              This workflow runs the next time “{TRIGGERS[w.trigger]?.label.toLowerCase()}” happens and the
              conditions match.
            </EmptyState>
          ) : null}
          <ul className="list">
            {(runs.data?.items ?? []).map((r) => (
              <li key={r.id} style={{ padding: "12px 18px" }}>
                <div className="spread">
                  <span className="row">
                    <Badge tone={RUN_TONE[r.status]}>{RUN_LABEL[r.status] ?? r.status}</Badge>
                    <span className="faint" style={{ fontSize: 12 }} title={formatDateTime(r.createdAt)}>
                      {r.triggeredBy} · {timeAgo(r.createdAt)} · attempt {r.attempts} of {r.maxAttempts}
                    </span>
                  </span>
                  {r.status === "FAILED" && can("workflow:manage") ? (
                    <Button
                      size="sm"
                      onClick={() => retry.mutate({ runId: r.id })}
                      loading={retry.isPending && retry.variables?.runId === r.id}
                      disabled={retry.isPending}
                    >
                      <RotateCw aria-hidden /> Retry
                    </Button>
                  ) : null}
                </div>
                {r.error ? (
                  <div className="form-error" style={{ marginTop: 8 }}>
                    {r.error}
                    {r.status === "PENDING" ? ` · next attempt ${timeAgo(r.nextAttemptAt)}` : ""}
                  </div>
                ) : null}
                {r.steps.length ? (
                  <ol className="timeline" style={{ marginTop: 10 }}>
                    {r.steps.map((s, i) => (
                      <li key={i}>
                        <span style={{ fontSize: 13 }}>
                          Step {s.stepIndex + 1} ·{" "}
                          {ACTION_LABELS[s.actionType as WorkflowAction["type"]] ?? s.actionType}{" "}
                          <Badge tone={s.status === "SUCCEEDED" ? "good" : "critical"}>
                            {s.status === "SUCCEEDED" ? "done" : "failed"}
                          </Badge>
                        </span>
                        {s.error ? (
                          <div className="faint" style={{ fontSize: 12 }}>
                            {s.error}
                          </div>
                        ) : null}
                        {s.output && typeof s.output.taskId === "string" ? (
                          <div style={{ fontSize: 12 }}>
                            <Link to={`/tasks/${s.output.taskId}`}>Open created task</Link>
                          </div>
                        ) : null}
                        {s.output && s.output.delivered === false ? (
                          <div className="faint" style={{ fontSize: 12 }}>
                            {String(s.output.reason)}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </li>
            ))}
          </ul>
          {runs.data ? (
            <div style={{ padding: "0 18px 12px" }}>
              <Pagination
                page={runs.data.page}
                pageCount={runs.data.pageCount}
                total={runs.data.total}
                noun="runs"
                onPage={setPage}
              />
            </div>
          ) : null}
        </Panel>
        <Panel title="Definition">
          <div className="stack" style={{ gap: 14 }}>
            <div>
              <p className="eyebrow">When</p>
              <div>{TRIGGERS[w.trigger]?.label ?? w.trigger}</div>
            </div>
            <div>
              <p className="eyebrow">If</p>
              {w.conditions.length === 0 ? (
                <div className="faint">Always</div>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {w.conditions.map((c, i) => (
                    <li key={i}>
                      {fieldLabel(w.trigger, c.field)} {OP_LABELS[c.op]}{" "}
                      {c.op === "is_set" || c.op === "is_empty" ? (
                        ""
                      ) : (
                        <strong>{label(c.value) || "“”"}</strong>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="eyebrow">Then</p>
              <ol style={{ margin: 0, paddingLeft: 18 }}>
                {w.actions.map((a, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>
                    {describeAction(a)}
                  </li>
                ))}
              </ol>
            </div>
            <div className="faint" style={{ fontSize: 12 }}>
              Runs with {w.ownerName ?? "no owner"}’s permissions (the last person to save it). Updated{" "}
              {timeAgo(w.updatedAt)}.
            </div>
          </div>
        </Panel>
      </div>
      <WorkflowFormDialog
        open={editing}
        onClose={() => setEditing(false)}
        initial={{
          id: w.id,
          name: w.name,
          description: w.description ?? "",
          trigger: w.trigger,
          conditions: w.conditions,
          actions: w.actions,
        }}
      />
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete “${w.name}”?`}
        body="Its run history is deleted too. Tasks and notifications it already created are kept. To stop it temporarily, pause it instead."
        confirmLabel="Delete workflow"
        danger
        loading={remove.isPending}
        onConfirm={() => remove.mutate({ id })}
      />
    </>
  );
}
