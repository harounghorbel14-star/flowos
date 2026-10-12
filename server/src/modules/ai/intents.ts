import { label, TASK_PRIORITIES, type TaskPriority, type TaskStatus } from "@shared/domain";
import { addDaysISO, todayISO } from "../../lib/dates";
import type {
  blockedWork,
  Evidence,
  overdueTasks,
  prioritize,
  RankedItem,
  resolutionSteps,
} from "./analysis";

/**
 * Rules mode: the commands FLOWOS understands without a language model. The
 * router recognises a fixed set of phrasings; anything else is answered with
 * the list of supported commands rather than a guess.
 */

export type Intent =
  | { kind: "help" }
  | { kind: "briefing" }
  | { kind: "priorities" }
  | { kind: "overdue"; mine: boolean }
  | { kind: "blocked_projects" }
  | { kind: "approvals" }
  | { kind: "my_tasks" }
  | { kind: "trends" }
  | { kind: "next_steps"; project: string }
  | { kind: "follow_up_blocked"; project?: string }
  | {
      kind: "create_task";
      title: string;
      dueDate?: string;
      priority?: TaskPriority;
      assignee?: string;
      project?: string;
    }
  | { kind: "set_status"; taskNumber: number; status: TaskStatus }
  | { kind: "remember"; content: string }
  | { kind: "mark_notifications_read" };

export const SUPPORTED_COMMANDS = [
  "What needs my attention?",
  "What should I prioritize today?",
  "What are the most urgent overdue tasks? (or: my overdue tasks)",
  "Which projects are blocked?",
  "Which approvals are waiting for me?",
  "Show my tasks",
  "Show weekly trends",
  "How can we unblock <project name>?",
  "Create follow-up tasks for blocked tasks [in <project>]",
  "Create task <title> [due tomorrow | in 3 days | 2026-11-02 | friday] [for <person>] [in project <name>] [high priority]",
  "Mark #12 as done (or: in progress, blocked, review, to do)",
  "Mark my notifications as read",
  "Remember <a preference>",
];

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Resolve a spoken due date. Weekdays mean the next such day after today. */
export function parseDue(text: string, today = todayISO()): string | null {
  const t = text.trim().toLowerCase();
  if (t === "today") return today;
  if (t === "tomorrow") return addDaysISO(today, 1);
  if (t === "next week") return addDaysISO(today, 7);
  const inDays = /^in (\d{1,3}) days?$/.exec(t);
  if (inDays) return addDaysISO(today, Number(inDays[1]));
  // Round-trip check: Date accepts 2026-02-31 and silently rolls it into March.
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const d = new Date(`${t}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t ? t : null;
  }
  const wd = WEEKDAYS.indexOf(t.replace(/^next /, ""));
  if (wd >= 0) {
    const now = new Date(`${today}T00:00:00Z`).getUTCDay();
    const ahead = (wd - now + 7) % 7 || 7;
    return addDaysISO(today, ahead);
  }
  return null;
}

const STATUS_WORDS: Record<string, TaskStatus> = {
  done: "DONE",
  complete: "DONE",
  completed: "DONE",
  finished: "DONE",
  "in progress": "IN_PROGRESS",
  started: "IN_PROGRESS",
  blocked: "BLOCKED",
  review: "REVIEW",
  "in review": "REVIEW",
  todo: "TODO",
  "to do": "TODO",
};

const strip = (s: string) => s.replace(/^["“'‘]|["”'’]$/g, "").trim();

function parseCreateTask(rest: string): Intent | null {
  let title = rest.trim();
  let dueDate: string | undefined;
  let priority: TaskPriority | undefined;
  let assignee: string | undefined;
  let project: string | undefined;
  // Modifiers come at the end, in any order.
  for (let i = 0; i < 4; i++) {
    let m =
      /\s+(?:due|by)\s+(today|tomorrow|next week|in \d{1,3} days?|\d{4}-\d{2}-\d{2}|(?:next )?(?:sun|mon|tues|wednes|thurs|fri|satur)day)$/i.exec(
        title,
      );
    if (m) {
      const d = parseDue(m[1]!);
      if (d) {
        dueDate = d;
        title = title.slice(0, m.index);
        continue;
      }
    }
    m = /\s+(?:with\s+)?(urgent|high|medium|low)\s+priority$|\s+priority\s+(urgent|high|medium|low)$/i.exec(
      title,
    );
    if (m) {
      priority = (m[1] ?? m[2])!.toUpperCase() as TaskPriority;
      title = title.slice(0, m.index);
      continue;
    }
    m = /\s+in\s+project\s+(.+)$/i.exec(title);
    if (m) {
      project = strip(m[1]!);
      title = title.slice(0, m.index);
      continue;
    }
    m = /\s+(?:for|assigned to|assign(?:ed)? it to)\s+([\p{L}][\p{L}'.-]*(?:\s+[\p{L}][\p{L}'.-]*)?)$/iu.exec(
      title,
    );
    if (m) {
      assignee = m[1]!;
      title = title.slice(0, m.index);
      continue;
    }
    break;
  }
  title = strip(title.replace(/[.\s]+$/, ""));
  if (!title || title.length > 200) return null;
  if (priority && !TASK_PRIORITIES.includes(priority)) priority = undefined;
  return { kind: "create_task", title, dueDate, priority, assignee, project };
}

/** Recognise a supported command, or null. Matching is deliberately conservative. */
export function routeIntent(raw: string): Intent | null {
  const text = raw.trim();
  const t = text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[?!.]+$/, "")
    .trim();
  if (!t) return null;
  if (/^(help|\?|commands|what can you do|what do you support)$/.test(t)) return { kind: "help" };

  const remember = /^(?:please\s+)?remember(?:\s+that)?[:\s]+([\s\S]{2,500})$/i.exec(text);
  if (remember) return { kind: "remember", content: remember[1]!.trim() };

  const create =
    /^(?:please\s+)?(?:create|add|make|open)\s+(?:a\s+|new\s+|a new\s+)?task\b\s*(?::|-|–|called|named)?\s*([\s\S]+)$/i.exec(
      text,
    );
  if (create) return parseCreateTask(create[1]!);

  const status =
    /^(?:please\s+)?(?:mark|set|move|change)\s+(?:task\s+)?#?(\d{1,9})\s+(?:as\s+|to\s+)?(done|complete|completed|finished|in progress|started|blocked|in review|review|todo|to do)$/.exec(
      t,
    );
  if (status) return { kind: "set_status", taskNumber: Number(status[1]), status: STATUS_WORDS[status[2]!]! };

  if (/^(?:please\s+)?(?:mark|set)\s+(?:all\s+)?(?:of\s+)?my\s+notifications\s+(?:as\s+)?read$/.test(t))
    return { kind: "mark_notifications_read" };

  const follow =
    /^(?:please\s+)?(?:create|add|prepare|make)\s+follow[- ]?ups?(?:\s+tasks?)?\s+(?:for|on)\s+(?:the\s+|all\s+)?blocked\s+tasks?(?:\s+in\s+(?:project\s+)?(.+))?$/.exec(
      t,
    );
  if (follow) return { kind: "follow_up_blocked", project: follow[1] ? strip(follow[1]) : undefined };

  const steps =
    /^(?:how|what)\s+(?:can|could|should|do)\s+(?:we|i)\s+(?:do\s+to\s+)?(?:fix|resolve|unblock|rescue|recover)\s+(?:the\s+)?(?:project\s+)?(.+?)(?:\s+project)?$/.exec(
      t,
    ) ??
    /^(?:next|suggested)\s+steps\s+(?:for|in|on)\s+(?:the\s+)?(?:project\s+)?(.+?)(?:\s+project)?$/.exec(t);
  if (steps) return { kind: "next_steps", project: strip(steps[1]!) };

  if (
    /\b(blocked|stuck|at risk|in trouble)\b.*\bprojects?\b|\bprojects?\b.*\b(blocked|stuck|at risk)\b/.test(t)
  )
    return { kind: "blocked_projects" };
  if (
    /\b(prioriti[sz]e|priorities|focus on|work on first|tackle first|should i (do|start|work on))\b/.test(t)
  )
    return { kind: "priorities" };
  if (/\b(overdue|past due|late tasks?)\b/.test(t))
    return { kind: "overdue", mine: /\b(my|mine|me|i)\b/.test(t) };
  if (/\bapprovals?\b|\bwaiting (for|on) (my )?(decision|approval)\b/.test(t)) return { kind: "approvals" };
  if (
    /\b(needs? my attention|what'?s (going on|happening)|brief(ing)?|overview|status report|summary)\b/.test(
      t,
    )
  )
    return { kind: "briefing" };
  if (/\bmy (open )?tasks\b|\bon my plate\b|\bassigned to me\b/.test(t)) return { kind: "my_tasks" };
  if (/\b(trends?|week over week|compared (to|with) last week)\b/.test(t)) return { kind: "trends" };
  return null;
}

export function describeIntent(i: Intent): string {
  switch (i.kind) {
    case "help":
      return "List what the assistant can do without a language model";
    case "briefing":
      return "Summarize what needs your attention";
    case "priorities":
      return "Rank what you should work on today";
    case "overdue":
      return i.mine ? "Rank your overdue tasks by urgency" : "Rank overdue tasks by urgency";
    case "blocked_projects":
      return "Find projects that appear blocked, with evidence";
    case "approvals":
      return "List approvals waiting for your decision";
    case "my_tasks":
      return "List your open tasks";
    case "trends":
      return "Report week-over-week trends";
    case "next_steps":
      return `Suggest steps to resolve problems in “${i.project}”`;
    case "follow_up_blocked":
      return `Prepare follow-up tasks for blocked tasks${i.project ? ` in “${i.project}”` : ""}`;
    case "create_task":
      return `Prepare a new task “${i.title}”`;
    case "set_status":
      return `Prepare moving task #${i.taskNumber} to “${label(i.status)}”`;
    case "remember":
      return "Save a preference";
    case "mark_notifications_read":
      return "Mark your notifications as read";
  }
}

// ─── Composing answers from real results ───────────────────────────────────────

export interface Answer {
  text: string;
  evidence: Evidence[];
  notes: string[];
}

const list = (items: RankedItem[]) =>
  items.map((it, n) => `${n + 1}. ${it.title}: ${it.reasons.join("; ")}`).join("\n");

export const compose = {
  help(): Answer {
    return {
      text: `Without a language model I handle these requests, using your organization's live records:\n${SUPPORTED_COMMANDS.map((c) => `• ${c}`).join("\n")}\n\nOther questions need an inference model configured on the server.`,
      evidence: [],
      notes: [],
    };
  },
  unsupported(hasModel: boolean, why: string | null): Answer {
    return {
      text: `I can't interpret that request${hasModel ? "" : " without a language model"}${why ? ` (${why})` : ""}. I won't guess. These requests work now:\n${SUPPORTED_COMMANDS.map((c) => `• ${c}`).join("\n")}`,
      evidence: [],
      notes: hasModel ? [] : ["No inference model is configured; FLOWOS is answering with its own rules."],
    };
  },
  priorities(r: Awaited<ReturnType<typeof prioritize>>): Answer {
    if (r.items.length === 0)
      return {
        text: "Nothing is waiting on you: no open tasks assigned to you, no approvals awaiting your decision, and no projects you own at risk.",
        evidence: [],
        notes: r.notes,
      };
    return {
      text: `Your priorities for ${r.today}, highest first:\n${list(r.items)}\n\nHow this is ranked: ${r.rules.join(" ")}`,
      evidence: r.items.map((i) => ({ kind: i.kind, id: i.id, label: i.title, link: i.link })),
      notes: r.notes,
    };
  },
  overdue(r: Awaited<ReturnType<typeof overdueTasks>>, mine: boolean): Answer {
    if (r.total === 0)
      return {
        text: mine ? "You have no overdue tasks." : "There are no overdue tasks.",
        evidence: [],
        notes: r.notes,
      };
    return {
      text: `${r.total} overdue task${r.total === 1 ? "" : "s"}${mine ? " assigned to you" : ""}. Most urgent first:\n${r.items
        .map((t, n) => `${n + 1}. ${t.title}${t.owner ? ` (${t.owner})` : ""}: ${t.reasons.join("; ")}`)
        .join("\n")}\n\n${r.rule}`,
      evidence: r.items.map((i) => ({ kind: "task" as const, id: i.id, label: i.title, link: i.link })),
      notes: r.notes,
    };
  },
  blocked(r: Awaited<ReturnType<typeof blockedWork>>): Answer {
    const blocked = r.projects.filter((p) => p.appearsBlocked);
    const watch = r.projects.filter((p) => !p.appearsBlocked);
    if (r.projects.length === 0)
      return {
        text: "No project shows signs of being blocked: no blocked tasks, nothing on hold, nothing overdue.",
        evidence: [],
        notes: r.notes,
      };
    const lines = (ps: typeof r.projects) =>
      ps
        .map(
          (p) =>
            `• ${p.name} (${label(p.status)}, ${p.progress}% done${p.owner ? `, owner ${p.owner}` : ""}): ${p.signals.join("; ")}${
              p.blockedTasks.length
                ? `\n  Blocked: ${p.blockedTasks.map((t) => `${t.title}${t.assignee ? ` (${t.assignee})` : ""}`).join(", ")}`
                : ""
            }`,
        )
        .join("\n");
    return {
      text: [
        blocked.length
          ? `Appear blocked (${blocked.length}):\n${lines(blocked)}`
          : "No project has blocked tasks or is on hold.",
        watch.length ? `Behind schedule but not marked blocked (${watch.length}):\n${lines(watch)}` : null,
      ]
        .filter(Boolean)
        .join("\n\n"),
      evidence: r.projects.map((p) => ({
        kind: "project" as const,
        id: p.projectId,
        label: p.name,
        link: p.link,
      })),
      notes: r.notes,
    };
  },
  nextSteps(r: Awaited<ReturnType<typeof resolutionSteps>>): Answer {
    return {
      text: r.steps.length
        ? `Suggested steps for ${r.project.name} (${r.openTasks} open task${r.openTasks === 1 ? "" : "s"}):\n${r.steps
            .map((s, n) => `${n + 1}. ${s.text}`)
            .join("\n")}`
        : `${r.project.name}: ${r.notes[0]}`,
      evidence: [
        { kind: "project", id: r.project.id, label: r.project.name, link: r.project.link },
        ...r.steps.flatMap((s) => s.evidence).filter((e) => e.kind === "task"),
      ],
      notes: r.steps.length ? r.notes : [],
    };
  },
};
