import { Check, X } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { label } from "@shared/domain";
import { useToast } from "../components/toast";
import {
  Avatar,
  Button,
  ConfirmDialog,
  ErrorState,
  Modal,
  PageHeader,
  Panel,
  SkeletonRows,
  StatusBadge,
  TextAreaField,
} from "../components/ui";
import { formatDateTime, formatDay, timeAgo } from "../lib/format";
import { errorCode, errorMessage, trpc } from "../lib/trpc";
import { NotFoundPage } from "./NotFound";

const EVENT_TEXT: Record<string, string> = {
  CREATED: "submitted the request",
  APPROVED: "approved",
  REJECTED: "rejected",
  CANCELLED: "withdrew the request",
  COMMENTED: "commented",
};

function PayloadFacts({ type, payload }: { type: string; payload: Record<string, unknown> }) {
  const s = (k: string) => (payload[k] === undefined || payload[k] === null ? "—" : String(payload[k]));
  if (type === "LEAVE") {
    const start = s("startDate");
    const end = s("endDate");
    const days =
      start !== "—" && end !== "—"
        ? Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1
        : null;
    return (
      <>
        <dt>Leave type</dt>
        <dd>{label(s("leaveType"))}</dd>
        <dt>Dates</dt>
        <dd>
          {formatDay(start)} – {formatDay(end)}
          {days ? (
            <span className="faint">
              {" "}
              · {days} calendar {days === 1 ? "day" : "days"}
            </span>
          ) : null}
        </dd>
      </>
    );
  }
  if (type === "PURCHASE") {
    const amount = Number(payload.amount);
    let formatted = s("amount");
    try {
      formatted = new Intl.NumberFormat(undefined, { style: "currency", currency: s("currency") }).format(
        amount,
      );
    } catch {
      /* unknown currency code — show raw */
    }
    return (
      <>
        <dt>Vendor</dt>
        <dd>{s("vendor")}</dd>
        <dt>Amount</dt>
        <dd className="num">{formatted}</dd>
      </>
    );
  }
  if (type === "HR") {
    return (
      <>
        <dt>Category</dt>
        <dd>{s("category")}</dd>
      </>
    );
  }
  if (type === "DOCUMENT") {
    return (
      <>
        <dt>Document</dt>
        <dd>{s("documentName")}</dd>
      </>
    );
  }
  return null;
}

export function ApprovalDetailPage() {
  const { id = "" } = useParams();
  const toast = useToast();
  const utils = trpc.useUtils();
  const request = trpc.approvals.get.useQuery({ id });
  const [deciding, setDeciding] = useState<"APPROVED" | "REJECTED" | null>(null);
  const [decisionComment, setDecisionComment] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [comment, setComment] = useState("");
  const refresh = () => Promise.all([utils.approvals.invalidate(), utils.dashboard.invalidate()]);
  const decide = trpc.approvals.decide.useMutation({
    onSuccess: async (r) => {
      await refresh();
      toast.success(r.status === "APPROVED" ? "Approved." : "Rejected.");
      setDeciding(null);
      setDecisionComment("");
    },
  });
  const cancel = trpc.approvals.cancel.useMutation({
    onSuccess: async () => {
      await refresh();
      toast.success("Request withdrawn.");
      setConfirmCancel(false);
    },
    onError: toast.error,
  });
  const addComment = trpc.approvals.comment.useMutation({
    onSuccess: async () => {
      setComment("");
      await utils.approvals.get.invalidate({ id });
    },
    onError: toast.error,
  });

  if (request.error && errorCode(request.error) === "NOT_FOUND") return <NotFoundPage what="request" />;
  if (request.error) return <ErrorState error={request.error} onRetry={() => void request.refetch()} />;
  if (!request.data) {
    return (
      <div className="panel">
        <SkeletonRows rows={6} />
      </div>
    );
  }
  const r = request.data;

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <Link to="/approvals">Approvals</Link> / {label(r.type)}
          </>
        }
        title={r.title}
        actions={
          <>
            {r.canDecide ? (
              <>
                <Button variant="accent" onClick={() => setDeciding("APPROVED")}>
                  <Check aria-hidden /> Approve
                </Button>
                <Button variant="danger" onClick={() => setDeciding("REJECTED")}>
                  <X aria-hidden /> Reject
                </Button>
              </>
            ) : null}
            {r.canCancel ? <Button onClick={() => setConfirmCancel(true)}>Withdraw</Button> : null}
          </>
        }
      />
      <div className="grid main-side">
        <div className="stack">
          {r.status !== "PENDING" ? (
            <div className="panel panel-body row">
              <StatusBadge value={r.status} />
              <span className="muted">
                {r.status === "CANCELLED" ? "Withdrawn by the requester" : `Decided by ${r.approverName}`} ·{" "}
                {r.decidedAt ? formatDateTime(r.decidedAt) : ""}
              </span>
              {r.decisionComment ? (
                <div className="prose" style={{ width: "100%" }}>
                  “{r.decisionComment}”
                </div>
              ) : null}
            </div>
          ) : null}
          <Panel title="Request">
            <dl className="facts">
              <dt>Status</dt>
              <dd>
                <StatusBadge value={r.status} />
              </dd>
              <dt>Requested by</dt>
              <dd>{r.requesterName}</dd>
              <dt>Approver</dt>
              <dd>{r.approverName}</dd>
              <PayloadFacts type={r.type} payload={r.payload} />
              <dt>Submitted</dt>
              <dd title={formatDateTime(r.createdAt)}>{timeAgo(r.createdAt)}</dd>
            </dl>
            {r.description ? (
              <div
                className="prose"
                style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--line)" }}
              >
                {r.description}
              </div>
            ) : null}
          </Panel>
        </div>
        <Panel title="Decision trail">
          <ol className="timeline">
            {r.events.map((e) => (
              <li key={e.id}>
                <div className="row" style={{ gap: 6 }}>
                  <Avatar name={e.actorName ?? "?"} />
                  <span style={{ fontSize: 13 }}>
                    <strong>{e.actorName ?? "Former member"}</strong>{" "}
                    {EVENT_TEXT[e.kind] ?? e.kind.toLowerCase()}
                  </span>
                </div>
                {e.comment ? (
                  <div className="comment prose" style={{ marginTop: 6, fontSize: 13 }}>
                    {e.comment}
                  </div>
                ) : null}
                <div
                  className="faint"
                  style={{ fontSize: 12, marginTop: 4 }}
                  title={formatDateTime(e.createdAt)}
                >
                  {timeAgo(e.createdAt)}
                </div>
              </li>
            ))}
          </ol>
          <form
            className="form"
            style={{ marginTop: 8 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (comment.trim()) addComment.mutate({ id, comment });
            }}
          >
            <label className="sr-only" htmlFor="approval-comment">
              Comment
            </label>
            <textarea
              id="approval-comment"
              className="textarea"
              rows={2}
              placeholder="Ask a question or add context…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <Button size="sm" type="submit" loading={addComment.isPending} disabled={!comment.trim()}>
                Comment
              </Button>
            </div>
          </form>
        </Panel>
      </div>

      <Modal
        open={deciding !== null}
        onClose={() => setDeciding(null)}
        title={deciding === "APPROVED" ? "Approve this request?" : "Reject this request?"}
        footer={
          <>
            <Button onClick={() => setDeciding(null)}>Cancel</Button>
            <Button
              variant={deciding === "APPROVED" ? "accent" : "danger"}
              className={deciding === "REJECTED" ? "solid" : undefined}
              loading={decide.isPending}
              disabled={deciding === "REJECTED" && !decisionComment.trim()}
              onClick={() =>
                deciding && decide.mutate({ id, decision: deciding, comment: decisionComment || null })
              }
            >
              {deciding === "APPROVED" ? "Approve" : "Reject"}
            </Button>
          </>
        }
      >
        <div className="form">
          {decide.error ? <div className="form-error">{errorMessage(decide.error)}</div> : null}
          <p className="muted" style={{ margin: 0 }}>
            {r.requesterName} will be notified. Decisions are final and recorded in the audit log.
          </p>
          <TextAreaField
            label={deciding === "REJECTED" ? "Reason (required)" : "Note (optional)"}
            value={decisionComment}
            onChange={(e) => setDecisionComment(e.target.value)}
            rows={3}
            autoFocus
          />
        </div>
      </Modal>
      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Withdraw this request?"
        body={`${r.approverName} will be notified that it no longer needs a decision.`}
        confirmLabel="Withdraw request"
        loading={cancel.isPending}
        onConfirm={() => cancel.mutate({ id })}
      />
    </>
  );
}
