import { Plus, Search, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { EMPLOYEE_STATUSES, label, type EmployeeStatus } from "@shared/domain";
import { EmployeeFormDialog } from "../components/forms/EmployeeForm";
import {
  Avatar,
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  SkeletonRows,
  StatusBadge,
} from "../components/ui";
import { formatDay, personName } from "../lib/format";
import { useOrg } from "../lib/session";
import { trpc } from "../lib/trpc";

export function PeoplePage() {
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

  const status = params.get("status") as EmployeeStatus | null;
  const departments = trpc.departments.list.useQuery();
  const list = trpc.employees.list.useQuery(
    {
      page: Number(params.get("page") ?? 1) || 1,
      pageSize: 25,
      search: params.get("q") || undefined,
      departmentId: params.get("department") || undefined,
      status: status && (EMPLOYEE_STATUSES as readonly string[]).includes(status) ? status : undefined,
      sort: (params.get("sort") as "name" | "recent" | "startDate") || "name",
    },
    { placeholderData: (prev) => prev },
  );
  const filtered = Boolean(params.get("q") || status || params.get("department"));

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="People"
        lede="Your directory of employees, their teams and reporting lines."
        actions={
          <>
            <Link className="btn" to="/people/departments">
              Departments
            </Link>
            {can("employee:write") ? (
              <Button variant="primary" onClick={() => update({ new: "1" }, false)}>
                <Plus aria-hidden /> Add employee
              </Button>
            ) : null}
          </>
        }
      />
      <div className="toolbar">
        <div className="search">
          <Search aria-hidden />
          <input
            className="input"
            placeholder="Search name, email or title"
            aria-label="Search people"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
        </div>
        <select
          className="select"
          style={{ width: "auto", maxWidth: 220 }}
          aria-label="Department"
          value={params.get("department") ?? ""}
          onChange={(e) => update({ department: e.target.value || null })}
        >
          <option value="">All departments</option>
          {(departments.data ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select
          className="select"
          style={{ width: "auto" }}
          aria-label="Status"
          value={status ?? ""}
          onChange={(e) => update({ status: e.target.value || null })}
        >
          <option value="">Any status</option>
          {EMPLOYEE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
        </select>
        <select
          className="select"
          style={{ width: "auto" }}
          aria-label="Sort"
          value={params.get("sort") ?? "name"}
          onChange={(e) => update({ sort: e.target.value })}
        >
          <option value="name">Name</option>
          <option value="recent">Recently added</option>
          <option value="startDate">Start date</option>
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
            icon={<Users size={18} />}
            title={filtered ? "No one matches" : "The directory is empty"}
            action={
              !filtered && can("employee:write") ? (
                <Button variant="primary" onClick={() => update({ new: "1" }, false)}>
                  <Plus aria-hidden /> Add the first employee
                </Button>
              ) : null
            }
          >
            {filtered
              ? "Try a different search or filter."
              : "Add employees to assign work, staff projects and route approvals."}
          </EmptyState>
        </div>
      ) : null}
      {list.data && list.data.total > 0 ? (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="hide-sm">Department</th>
                  <th className="hide-sm">Manager</th>
                  <th>Status</th>
                  <th className="hide-sm">Started</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((e) => (
                  <tr key={e.id}>
                    <td style={{ minWidth: 220 }}>
                      <div className="row" style={{ flexWrap: "nowrap" }}>
                        <Avatar name={personName(e.firstName, e.lastName)} />
                        <div style={{ minWidth: 0 }}>
                          <Link className="row-link" to={`/people/${e.id}`}>
                            {personName(e.firstName, e.lastName)}
                          </Link>
                          <div className="faint truncate" style={{ fontSize: 12 }}>
                            {e.jobTitle ?? e.email}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="hide-sm">{e.departmentName ?? <span className="faint">—</span>}</td>
                    <td className="hide-sm">
                      {e.managerId ? (
                        personName(e.managerFirstName, e.managerLastName)
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td>
                      <StatusBadge value={e.status} />
                    </td>
                    <td className="hide-sm num muted">{formatDay(e.startDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={list.data.page}
            pageCount={list.data.pageCount}
            total={list.data.total}
            noun="people"
            onPage={(p) => update({ page: String(p) }, false)}
          />
        </>
      ) : null}
      <EmployeeFormDialog
        open={params.get("new") === "1"}
        onClose={() => update({ new: null }, false)}
        initial={{ departmentId: params.get("department") ?? "" }}
        onSaved={(id) => navigate(`/people/${id}`)}
      />
    </>
  );
}
