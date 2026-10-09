import {
  Bell,
  Building2,
  CheckSquare,
  FileText,
  FolderKanban,
  LayoutDashboard,
  Plus,
  Search,
  Settings,
  Sparkles,
  Stamp,
  User,
  Users,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useOrg } from "../lib/session";
import { trpc } from "../lib/trpc";

interface Item {
  id: string;
  group: string;
  title: string;
  subtitle?: string | null;
  icon: ReactNode;
  to: string;
}

const KIND_ICON: Record<string, ReactNode> = {
  employee: <User aria-hidden />,
  department: <Building2 aria-hidden />,
  project: <FolderKanban aria-hidden />,
  task: <CheckSquare aria-hidden />,
  approval: <Stamp aria-hidden />,
  document: <FileText aria-hidden />,
};
const KIND_GROUP: Record<string, string> = {
  employee: "People",
  department: "Departments",
  project: "Projects",
  task: "Tasks",
  approval: "Approvals",
  document: "Documents",
};

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const navigate = useNavigate();
  const { can } = useOrg();
  const debounced = useDebounced(q.trim(), 180);
  const search = trpc.search.global.useQuery({ q: debounced }, { enabled: open && debounced.length >= 2 });

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setQ("");
      setIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
    if (!open && d.open) d.close();
  }, [open]);

  const actions = useMemo<Item[]>(() => {
    const list: Item[] = [
      {
        id: "nav-home",
        group: "Go to",
        title: "Command center",
        icon: <LayoutDashboard aria-hidden />,
        to: "/",
      },
      {
        id: "nav-assistant",
        group: "Go to",
        title: "Assistant",
        icon: <Sparkles aria-hidden />,
        to: "/assistant",
      },
      { id: "nav-tasks", group: "Go to", title: "Tasks", icon: <CheckSquare aria-hidden />, to: "/tasks" },
      {
        id: "nav-mine",
        group: "Go to",
        title: "My tasks",
        icon: <CheckSquare aria-hidden />,
        to: "/tasks?view=mine",
      },
      {
        id: "nav-projects",
        group: "Go to",
        title: "Projects",
        icon: <FolderKanban aria-hidden />,
        to: "/projects",
      },
      {
        id: "nav-approvals",
        group: "Go to",
        title: "Approvals",
        icon: <Stamp aria-hidden />,
        to: "/approvals",
      },
      { id: "nav-people", group: "Go to", title: "People", icon: <Users aria-hidden />, to: "/people" },
      ...(can("workflow:read")
        ? [
            {
              id: "nav-workflows",
              group: "Go to",
              title: "Workflows",
              icon: <Workflow aria-hidden />,
              to: "/workflows",
            },
          ]
        : []),
      {
        id: "nav-notes",
        group: "Go to",
        title: "Notifications",
        icon: <Bell aria-hidden />,
        to: "/notifications",
      },
      {
        id: "nav-settings",
        group: "Go to",
        title: "Settings",
        icon: <Settings aria-hidden />,
        to: "/settings",
      },
    ];
    if (can("task:create"))
      list.unshift({
        id: "new-task",
        group: "Create",
        title: "New task",
        icon: <Plus aria-hidden />,
        to: "/tasks?new=1",
      });
    if (can("approval:create"))
      list.unshift({
        id: "new-approval",
        group: "Create",
        title: "New approval request",
        icon: <Plus aria-hidden />,
        to: "/approvals?new=1",
      });
    if (can("project:write"))
      list.unshift({
        id: "new-project",
        group: "Create",
        title: "New project",
        icon: <Plus aria-hidden />,
        to: "/projects?new=1",
      });
    if (can("employee:write"))
      list.unshift({
        id: "new-employee",
        group: "Create",
        title: "New employee",
        icon: <Plus aria-hidden />,
        to: "/people?new=1",
      });
    return list;
  }, [can]);

  const items = useMemo<Item[]>(() => {
    const term = q.trim().toLowerCase();
    const matchedActions = term ? actions.filter((a) => a.title.toLowerCase().includes(term)) : actions;
    const hits: Item[] =
      term.length >= 2 && debounced === q.trim()
        ? (search.data ?? []).map((h) => ({
            id: `${h.kind}-${h.id}`,
            group: KIND_GROUP[h.kind] ?? h.kind,
            title: h.title,
            subtitle: h.subtitle,
            icon: KIND_ICON[h.kind] ?? <Search aria-hidden />,
            to: h.link,
          }))
        : [];
    return [...hits, ...matchedActions];
  }, [actions, q, debounced, search.data]);

  useEffect(() => setIndex(0), [q]);

  const go = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    navigate(item.to);
  };

  let lastGroup = "";
  return (
    <dialog
      ref={ref}
      className="palette"
      aria-label="Command palette"
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="palette-input">
        <Search size={18} aria-hidden className="faint" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search people, tasks, projects, approvals…"
          aria-label="Search"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-activedescendant={items[index] ? `pi-${items[index]!.id}` : undefined}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(items.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              go(items[index]);
            }
          }}
        />
      </div>
      <ul className="palette-results" id="palette-results" role="listbox">
        {items.length === 0 ? (
          <li className="palette-group" role="presentation">
            {search.isFetching ? "Searching…" : "No matches in this organization"}
          </li>
        ) : null}
        {items.map((item, i) => {
          const header = item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          return (
            <li key={item.id} role="presentation">
              {header ? <div className="palette-group">{header}</div> : null}
              <div
                id={`pi-${item.id}`}
                role="option"
                aria-selected={i === index}
                className="palette-item"
                onMouseMove={() => setIndex(i)}
                onClick={() => go(item)}
              >
                {item.icon}
                <span className="truncate">{item.title}</span>
                {item.subtitle ? (
                  <span className="faint truncate" style={{ marginLeft: "auto", fontSize: 12 }}>
                    {item.subtitle}
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="palette-foot">
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> navigate
        </span>
        <span>
          <kbd>↵</kbd> open
        </span>
        <span>
          <kbd>esc</kbd> close
        </span>
        <span style={{ marginLeft: "auto" }}>Results respect your permissions</span>
      </div>
    </dialog>
  );
}
