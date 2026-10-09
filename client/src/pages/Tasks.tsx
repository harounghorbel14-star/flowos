import { CheckSquare, Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { TASK_PRIORITIES, TASK_STATUSES, label, type TaskPriority, type TaskStatus } from "@shared/domain";
import { TaskFormDialog } from "../components/forms/TaskForm";
import { useToast } from "../components/toast";
import {
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  SkeletonRows,
  StatusBadge,
} from "../components/ui";
import { dueLabel, formatDay, personName } from "../lib/format";
import { useOrg } from "../lib/session";
import { trpc, type RouterInputs } from "../lib/trpc";

type ListInput = RouterInputs["tasks"]["list"];

export function TasksPage() {
  const { org, can } = useOrg();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const utils = trpc.useUtils();
  const [searchText, setSearchText] = useState(params.get("q") ?? "");
  const creating = params.get("new") === "1";

  const update = (patch: Record<string, string | null>, resetPage = true) => {
    const next = new URLSearchParams(params);
    for (const [k, value] of Object.entries(patch)) {
      if (value === null || value === "") next.delete(k);
      else next.set(k, value);
    }
    if (resetPage) next.delete("page");
    setParams(next, { replace: true });
  };

  // Debounce the free-text search into the URL.
  useEffect(() => {
    const t = setTimeout(() => {
      if ((params.get("q") ?? "") !== searchText) update({ q: searchText || null });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  const statuses = (params
    .get("status")
    ?.split(",")
    .filter((s) => (TASK_STATUSES as readonly string[]).includes(s)) ?? []) as TaskStatus[];
  const priority = params.get("priority") as TaskPriority | null;
  const input: ListInput = {
    page: Number(params.get("page") ?? 1) || 1,
    pageSize: 25,
    search: params.get("q") || undefined,
    statuses: statuses.length ? statuses : undefined,
    priorities:
      priority && (TASK_PRIORITIES as readonly string[]).includes(priority) ? [priority] : undefined,
    projectId: params.get("project") || undefined,
    mine: params.get("view") === "mine" || undefined,
    overdue: params.get("overdue") === "1" || undefined,
    unassigned: params.get("unassigned") === "1" || undefined,
    sort: (params.get("sort") as ListInput["sort"]) || "recent",
  };
  const list = trpc.tasks.list.useQuery(input, { placeholderData: (prev) => prev });
  const projects = trpc.projects.options.useQuery();
  const quickStatus = trpc.tasks.update.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.tasks.invalidate(), utils.dashboard.invalidate()]);
    },
    onError: toast.error,
  });

  const toggleStatus = (s: TaskStatus) => {
    const set = new Set(statuses);
    if (set.has(s)) set.delete(s);
    else set.add(s);
    update({ status: [...set].join(",") || null });
  };
  const filtered = Boolean(
    input.search ||
    input.statuses ||
    input.priorities ||
    input.projectId ||
    input.overdue ||
    input.unassigned,
  );

  return (
    <>
      <PageHeader
        eyebrow="Execute"
        title="Tasks"
        lede="Every piece of work in one place — filter, prioritise and move it forward."
        actions={
          can("task:create") ? (
            <Button variant="primary" onClick={() => update({ new: "1" }, false)}>
              <Plus aria-hidden /> New task
            </Button>
          ) : null
        }
      />

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Scope">
          <button aria-pressed={!input.mine} onClick={() => update({ view: null })}>
            All
          </button>
          <button aria-pressed={Boolean(input.mine)} onClick={() => update({ view: "mine" })}>
            Mine
          </button>
        </div>
        <div className="search">
          <Search aria-hidden />
          <input
            className="input"
            placeholder={`Search title or key (${org.taskPrefix ?? "FLW"}-12)`}
            aria-label="Search tasks"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
        </div>
        <select
          className="select"
          style={{ width: "auto" }}
          aria-label="Priority"
          value={priority ?? ""}
          onChange={(e) => update({ priority: e.target.value || null })}
        >
          <option value="">Any priority</option>
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {label(p)}
            </option>
          ))}
        </select>
        <select
          className="select"
          style={{ width: "auto", maxWidth: 200 }}
          aria-label="Project"
          value={input.projectId ?? ""}
          onChange={(e) => update({ project: e.target.value || null })}
        >
          <option value="">Any project</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          className="select"
          style={{ width: "auto" }}
          aria-label="Sort"
          value={input.sort}
          onChange={(e) => update({ sort: e.target.value })}
        >
          <option value="recent">Newest</option>
          <option value="due">Due date</option>
          <option value="priority">Priority</option>
          <option value="updated">Recently updated</option>
        </select>
      </div>
      <div className="toolbar" role="group" aria-label="Status filters">
        {TASK_STATUSES.map((s) => (
          <button
            key={s}
            className="chip-toggle"
            aria-pressed={statuses.includes(s)}
            onClick={() => toggleStatus(s)}
          >
            {label(s)}
          </button>
        ))}
        <span className="faint" aria-hidden>
          ·
        </span>
        <button
          className="chip-toggle"
          aria-pressed={Boolean(input.overdue)}
          onClick={() => update({ overdue: input.overdue ? null : "1" })}
        >
          Overdue
        </button>
        <button
          className="chip-toggle"
          aria-pressed={Boolean(input.unassigned)}
          onClick={() => update({ unassigned: input.unassigned ? null : "1" })}
        >
          Unassigned
        </button>
        {filtered ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setSearchText("");
              update({
                q: null,
                status: null,
                priority: null,
                project: null,
                overdue: null,
                unassigned: null,
              });
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>

      {list.error ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
      {list.isLoading ? (
        <div className="panel">
          <SkeletonRows rows={8} />
        </div>
      ) : null}
      {list.data && list.data.total === 0 ? (
        <div className="panel">
          <EmptyState
            icon={<CheckSquare size={18} />}
            title={
              filtered
                ? "No tasks match these filters"
                : input.mine
                  ? "Nothing assigned to you"
                  : "No tasks yet"
            }
            action={
              !filtered && can("task:create") ? (
                <Button variant="primary" onClick={() => update({ new: "1" }, false)}>
                  <Plus aria-hidden /> Create the first task
                </Button>
              ) : null
            }
          >
            {filtered ? "Try removing a filter." : "Tasks you and your team create will appear here."}
          </EmptyState>
        </div>
      ) : null}
      {list.data && list.data.total > 0 ? (
        <>
          <div className="table-wrap" aria-busy={list.isFetching}>
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 70 }}>Key</th>
                  <th>Task</th>
                  <th>Status</th>
                  <th className="hide-sm">Priority</th>
                  <th className="hide-sm">Assignee</th>
                  <th>Due</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((t) => {
                  const due =
                    t.status === "DONE"
                      ? { text: formatDay(t.dueDate), tone: "none" as const }
                      : dueLabel(t.dueDate);
                  return (
                    <tr key={t.id}>
                      <td className="key">
                        {org.taskPrefix ?? "FLW"}-{t.number}
                      </td>
                      <td style={{ minWidth: 220 }}>
                        <Link to={`/tasks/${t.id}`} className="row-link">
                          {t.title}
                        </Link>
                        {t.projectName ? (
                          <div className="faint" style={{ fontSize: 12 }}>
                            {t.projectName}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {can("task:write_any") ? (
                          <select
                            className="select"
                            style={{ height: 28, width: 132, fontSize: 13 }}
                            aria-label={`Status of ${t.title}`}
                            value={t.status}
                            disabled={quickStatus.isPending}
                            onChange={(e) =>
                              quickStatus.mutate({ id: t.id, status: e.target.value as TaskStatus })
                            }
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
                      </td>
                      <td className="hide-sm">
                        <StatusBadge value={t.priority} dot={false} />
                      </td>
                      <td className="hide-sm">
                        {t.assigneeEmployeeId ? (
                          personName(t.assigneeFirstName, t.assigneeLastName)
                        ) : (
                          <span className="faint">Unassigned</span>
                        )}
                      </td>
                      <td
                        className={due.tone === "critical" ? "num" : "num muted"}
                        style={due.tone === "critical" ? { color: "var(--critical)" } : undefined}
                      >
                        {t.dueDate ? due.text : <span className="faint">—</span>}
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
            noun="tasks"
            onPage={(p) => update({ page: String(p) }, false)}
          />
        </>
      ) : null}

      <TaskFormDialog
        open={creating}
        onClose={() => update({ new: null }, false)}
        initial={{ projectId: input.projectId ?? "" }}
      />
    </>
  );
}
