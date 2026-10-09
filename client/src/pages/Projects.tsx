import { FolderKanban, Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { PROJECT_STATUSES, label, type ProjectStatus } from "@shared/domain";
import { ProjectFormDialog } from "../components/forms/ProjectForm";
import {
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  Progress,
  SkeletonRows,
  StatusBadge,
} from "../components/ui";
import { dueLabel, formatDay, percent, personName } from "../lib/format";
import { useOrg } from "../lib/session";
import { trpc } from "../lib/trpc";

export function ProjectsPage() {
  const { can } = useOrg();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [searchText, setSearchText] = useState(params.get("q") ?? "");
  const update = (patch: Record<string, string | null>, resetPage = true) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (!v) next.delete(k);
      else next.set(k, v);
    }
    if (resetPage) next.delete("page");
    setParams(next, { replace: true });
  };
  useEffect(() => {
    const t = setTimeout(() => {
      if ((params.get("q") ?? "") !== searchText) update({ q: searchText || null });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  const status = params.get("status") as ProjectStatus | null;
  const list = trpc.projects.list.useQuery(
    {
      page: Number(params.get("page") ?? 1) || 1,
      pageSize: 20,
      search: params.get("q") || undefined,
      status: status && (PROJECT_STATUSES as readonly string[]).includes(status) ? status : undefined,
      sort: (params.get("sort") as "recent" | "due" | "name") || "recent",
    },
    { placeholderData: (prev) => prev },
  );
  const filtered = Boolean(params.get("q") || status);

  return (
    <>
      <PageHeader
        eyebrow="Execute"
        title="Projects"
        lede="Progress is the share of a project’s tasks that are done. Risk flags are explicit rules, shown on each project."
        actions={
          can("project:write") ? (
            <Button variant="primary" onClick={() => update({ new: "1" }, false)}>
              <Plus aria-hidden /> New project
            </Button>
          ) : null
        }
      />
      <div className="toolbar">
        <div className="search">
          <Search aria-hidden />
          <input
            className="input"
            placeholder="Search projects"
            aria-label="Search projects"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
        </div>
        <select
          className="select"
          style={{ width: "auto" }}
          aria-label="Status"
          value={status ?? ""}
          onChange={(e) => update({ status: e.target.value || null })}
        >
          <option value="">Any status</option>
          {PROJECT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
        </select>
        <select
          className="select"
          style={{ width: "auto" }}
          aria-label="Sort"
          value={params.get("sort") ?? "recent"}
          onChange={(e) => update({ sort: e.target.value })}
        >
          <option value="recent">Recently active</option>
          <option value="due">Due date</option>
          <option value="name">Name</option>
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
            icon={<FolderKanban size={18} />}
            title={filtered ? "No projects match" : "No projects yet"}
            action={
              !filtered && can("project:write") ? (
                <Button variant="primary" onClick={() => update({ new: "1" }, false)}>
                  <Plus aria-hidden /> Start a project
                </Button>
              ) : null
            }
          >
            {filtered
              ? "Try a different search or status."
              : "Projects group related tasks so you can see real progress and risk."}
          </EmptyState>
        </div>
      ) : null}
      {list.data && list.data.total > 0 ? (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Status</th>
                  <th style={{ width: 180 }}>Progress</th>
                  <th className="hide-sm">Owner</th>
                  <th>Due</th>
                  <th className="hide-sm">Flags</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((p) => {
                  const due =
                    p.status === "COMPLETED" || p.status === "CANCELLED" ? null : dueLabel(p.dueDate);
                  return (
                    <tr key={p.id}>
                      <td style={{ minWidth: 200 }}>
                        <Link className="row-link" to={`/projects/${p.id}`}>
                          {p.name}
                        </Link>
                      </td>
                      <td>
                        <StatusBadge value={p.status} />
                      </td>
                      <td>
                        <div className="row" style={{ flexWrap: "nowrap" }}>
                          <Progress value={p.stats.progress} label={`${p.name} progress`} />
                          <span className="num faint" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                            {p.stats.total
                              ? `${p.stats.done}/${p.stats.total} · ${percent(p.stats.progress)}`
                              : "No tasks"}
                          </span>
                        </div>
                      </td>
                      <td className="hide-sm">
                        {p.ownerEmployeeId ? (
                          personName(p.ownerFirstName, p.ownerLastName)
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td
                        className="num"
                        style={due?.tone === "critical" ? { color: "var(--critical)" } : undefined}
                      >
                        {p.dueDate ? due ? due.text : formatDay(p.dueDate) : <span className="faint">—</span>}
                      </td>
                      <td className="hide-sm">
                        {p.risk.length ? (
                          <span className="badge attention" title={p.risk.join("\n")}>
                            {p.risk.length} risk {p.risk.length === 1 ? "flag" : "flags"}
                          </span>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination
            page={list.data.page}
            pageCount={list.data.pageCount}
            total={list.data.total}
            noun="projects"
            onPage={(p) => update({ page: String(p) }, false)}
          />
        </>
      ) : null}
      <ProjectFormDialog
        open={params.get("new") === "1"}
        onClose={() => update({ new: null }, false)}
        onSaved={(id) => navigate(`/projects/${id}`)}
      />
    </>
  );
}
