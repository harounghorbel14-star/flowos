import { Plus, Stamp } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  APPROVAL_STATUSES,
  APPROVAL_TYPES,
  label,
  type ApprovalStatus,
  type ApprovalType,
} from "@shared/domain";
import { ApprovalFormDialog } from "../components/forms/ApprovalForm";
import {
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  SkeletonRows,
  StatusBadge,
} from "../components/ui";
import { timeAgo } from "../lib/format";
import { useOrg } from "../lib/session";
import { trpc } from "../lib/trpc";

type Box = "inbox" | "outbox" | "all";

export function ApprovalsPage() {
  const { can } = useOrg();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const update = (patch: Record<string, string | null>, resetPage = true) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (!v) next.delete(k);
      else next.set(k, v);
    }
    if (resetPage) next.delete("page");
    setParams(next, { replace: true });
  };
  const box = (
    ["inbox", "outbox", "all"].includes(params.get("box") ?? "") ? params.get("box") : "inbox"
  ) as Box;
  const status = params.get("status") as ApprovalStatus | null;
  const type = params.get("type") as ApprovalType | null;
  const list = trpc.approvals.list.useQuery(
    {
      box,
      page: Number(params.get("page") ?? 1) || 1,
      pageSize: 25,
      status:
        status && (APPROVAL_STATUSES as readonly string[]).includes(status)
          ? status
          : box === "inbox" && !params.has("status")
            ? "PENDING"
            : undefined,
      type: type && (APPROVAL_TYPES as readonly string[]).includes(type) ? type : undefined,
    },
    { placeholderData: (prev) => prev },
  );
  const effectiveStatus = box === "inbox" && !params.has("status") ? "PENDING" : (status ?? "");

  return (
    <>
      <PageHeader
        eyebrow="Decide"
        title="Approvals"
        lede="Leave, HR, purchase and document requests — each with a named approver and a complete decision trail."
        actions={
          can("approval:create") ? (
            <Button variant="primary" onClick={() => update({ new: "1" }, false)}>
              <Plus aria-hidden /> New request
            </Button>
          ) : null
        }
      />
      <nav className="tabs" aria-label="Approval views">
        <button
          type="button"
          aria-pressed={box === "inbox"}
          onClick={() => update({ box: null, status: null })}
        >
          Waiting on me
        </button>
        <button
          type="button"
          aria-pressed={box === "outbox"}
          onClick={() => update({ box: "outbox", status: null })}
        >
          My requests
        </button>
        {can("approval:read_all") ? (
          <button
            type="button"
            aria-pressed={box === "all"}
            onClick={() => update({ box: "all", status: null })}
          >
            All requests
          </button>
        ) : null}
      </nav>
      <div className="toolbar">
        <select
          className="select"
          style={{ width: "auto" }}
          aria-label="Status"
          value={effectiveStatus}
          onChange={(e) => update({ status: e.target.value || "ANY" })}
        >
          <option value="ANY">Any status</option>
          {APPROVAL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
        </select>
        <select
          className="select"
          style={{ width: "auto" }}
          aria-label="Type"
          value={type ?? ""}
          onChange={(e) => update({ type: e.target.value || null })}
        >
          <option value="">Any type</option>
          {APPROVAL_TYPES.map((t) => (
            <option key={t} value={t}>
              {label(t)}
            </option>
          ))}
        </select>
      </div>
      {list.error ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
      {list.isLoading ? (
        <div className="panel">
          <SkeletonRows />
        </div>
      ) : null}
      {list.data && list.data.total === 0 ? (
        <div className="panel">
          <EmptyState
            icon={<Stamp size={18} />}
            title={box === "inbox" ? "Nothing waiting for your decision" : "No requests here"}
          >
            {box === "outbox"
              ? "Requests you send for approval are tracked here."
              : "When someone names you as their approver, the request lands here."}
          </EmptyState>
        </div>
      ) : null}
      {list.data && list.data.total > 0 ? (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Type</th>
                  <th>{box === "outbox" ? "Approver" : "Requester"}</th>
                  <th>Status</th>
                  <th className="hide-sm">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((r) => (
                  <tr key={r.id}>
                    <td style={{ minWidth: 200 }}>
                      <Link className="row-link" to={`/approvals/${r.id}`}>
                        {r.title}
                      </Link>
                    </td>
                    <td>{label(r.type)}</td>
                    <td>{box === "outbox" ? r.approverName : r.requesterName}</td>
                    <td>
                      <StatusBadge value={r.status} />
                    </td>
                    <td className="hide-sm muted">{timeAgo(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={list.data.page}
            pageCount={list.data.pageCount}
            total={list.data.total}
            noun="requests"
            onPage={(p) => update({ page: String(p) }, false)}
          />
        </>
      ) : null}
      <ApprovalFormDialog
        open={params.get("new") === "1"}
        onClose={() => update({ new: null }, false)}
        onSaved={(id) => navigate(`/approvals/${id}`)}
      />
    </>
  );
}
