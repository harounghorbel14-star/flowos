import {
  Bell,
  Building2,
  CheckSquare,
  FileText,
  FolderKanban,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Search,
  Settings,
  Sparkles,
  Stamp,
  Sun,
  TrendingUp,
  Users,
  Workflow,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { label } from "@shared/domain";
import { useOrg } from "../lib/session";
import { trpc } from "../lib/trpc";
import { CommandPalette } from "./CommandPalette";
import { useToast } from "./toast";

type Theme = "light" | "dark" | null;
function readTheme(): Theme {
  try {
    const t = localStorage.getItem("flowos.theme");
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null;
  }
}

export function Shell() {
  const { org, organizations, switchOrg, user, can } = useOrg();
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const railRef = useRef<HTMLElement>(null);
  const navToggleRef = useRef<HTMLButtonElement>(null);

  const unread = trpc.notifications.unreadCount.useQuery(undefined, { refetchInterval: 30_000 });
  const inbox = trpc.approvals.list.useQuery(
    { box: "inbox", status: "PENDING", pageSize: 1 },
    { refetchInterval: 60_000 },
  );
  const logout = trpc.auth.logout.useMutation({
    onSuccess: () => {
      // Drop every cached record, then mark the session gone and leave.
      queryClient.clear();
      utils.auth.me.setData(undefined, null);
      navigate("/login", { replace: true });
    },
    onError: toast.error,
  });

  useEffect(() => setNavOpen(false), [location.pathname]);

  const closeNav = () => {
    setNavOpen(false);
    navToggleRef.current?.focus();
  };

  // Mobile drawer: move focus into it on open; Escape closes it and returns focus to the toggle.
  useEffect(() => {
    if (!navOpen) return;
    railRef.current?.querySelector<HTMLElement>("a, button, select")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setNavOpen(false);
        navToggleRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme) root.setAttribute("data-theme", theme);
    else root.removeAttribute("data-theme");
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleTheme = () => {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const current = theme ?? (prefersDark ? "dark" : "light");
    const nextTheme = current === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    try {
      localStorage.setItem("flowos.theme", nextTheme);
    } catch {
      /* ignore */
    }
  };

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const pendingApprovals = inbox.data?.total ?? 0;
  const unreadCount = unread.data ?? 0;

  return (
    <div className={navOpen ? "shell nav-open" : "shell"}>
      <nav className="rail" id="app-rail" ref={railRef} aria-label="Main navigation">
        <NavLink to="/" className="brand" aria-label="FLOWOS home">
          <span className="brand-mark" aria-hidden>
            F
          </span>
          <span className="brand-name">FLOWOS</span>
        </NavLink>

        <label className="sr-only" htmlFor="org-switch">
          Organization
        </label>
        <select
          id="org-switch"
          className="org-switch"
          value={org.id}
          onChange={(e) => {
            if (e.target.value === "__new") navigate("/onboarding");
            else {
              switchOrg(e.target.value);
              navigate("/");
            }
          }}
        >
          {organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name} · {label(o.role)}
            </option>
          ))}
          <option value="__new">+ New organization…</option>
        </select>

        <button type="button" className="search-trigger" onClick={() => setPaletteOpen(true)}>
          <Search size={15} aria-hidden /> <span>Search or jump to…</span>
          <kbd>{isMac ? "⌘K" : "Ctrl K"}</kbd>
        </button>

        <div className="rail-section">Operate</div>
        <NavLink to="/" end className="nav">
          <LayoutDashboard aria-hidden /> Command center
        </NavLink>
        <NavLink to="/tasks" className="nav">
          <CheckSquare aria-hidden /> Tasks
        </NavLink>
        <NavLink to="/projects" className="nav">
          <FolderKanban aria-hidden /> Projects
        </NavLink>
        <NavLink to="/approvals" className="nav">
          <Stamp aria-hidden /> Approvals
          {pendingApprovals > 0 ? (
            <span className="count" aria-label={`${pendingApprovals} awaiting you`}>
              {pendingApprovals}
            </span>
          ) : null}
        </NavLink>

        <NavLink to="/insights" className="nav">
          <TrendingUp aria-hidden /> Insights
        </NavLink>
        <NavLink to="/assistant" className="nav">
          <Sparkles aria-hidden /> Assistant
        </NavLink>
        {can("workflow:read") ? (
          <NavLink to="/workflows" className="nav">
            <Workflow aria-hidden /> Workflows
          </NavLink>
        ) : null}

        <div className="rail-section">Organization</div>
        <NavLink to="/people" end className="nav">
          <Users aria-hidden /> People
        </NavLink>
        <NavLink to="/people/departments" className="nav">
          <Building2 aria-hidden /> Departments
        </NavLink>
        <NavLink to="/documents" className="nav">
          <FileText aria-hidden /> Documents
        </NavLink>
        {can("org:update") || can("member:manage") || can("audit:read") ? (
          <NavLink to="/settings" className="nav">
            <Settings aria-hidden /> Settings
          </NavLink>
        ) : (
          <NavLink to="/settings/members" className="nav">
            <Settings aria-hidden /> Members
          </NavLink>
        )}

        <div className="rail-foot">
          <NavLink to="/notifications" className="nav">
            <Bell aria-hidden /> Notifications
            {unreadCount > 0 ? (
              <span className="count" aria-label={`${unreadCount} unread`}>
                {unreadCount}
              </span>
            ) : null}
          </NavLink>
          <button type="button" className="nav" onClick={toggleTheme}>
            {theme === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />} Toggle theme
          </button>
          <button type="button" className="nav" onClick={() => logout.mutate()} disabled={logout.isPending}>
            <LogOut aria-hidden />
            <span className="truncate" title={user.email}>
              Sign out · {user.name}
            </span>
          </button>
        </div>
      </nav>
      {navOpen ? <div className="scrim" onClick={closeNav} aria-hidden /> : null}

      <div className="main">
        <div className="topbar">
          <button
            ref={navToggleRef}
            className="btn icon ghost"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            aria-expanded={navOpen}
            aria-controls="app-rail"
          >
            <Menu size={18} aria-hidden />
          </button>
          <span className="brand-name" style={{ color: "var(--ink)" }}>
            FLOWOS
          </span>
          <span style={{ marginLeft: "auto" }} />
          <button className="btn icon ghost" onClick={() => setPaletteOpen(true)} aria-label="Search">
            <Search size={18} aria-hidden />
          </button>
        </div>
        <main className="page" key={org.id}>
          <Outlet />
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
