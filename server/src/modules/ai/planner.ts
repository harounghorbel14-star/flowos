import { label } from "@shared/domain";
import { addDaysISO, todayISO } from "../../lib/dates";
import type { blockedWork, Evidence, overdueTasks, prioritize, resolutionSteps } from "./analysis";
import type { StepOutcome } from "./executor";
import { compose, type Answer, type Intent } from "./intents";

/**
 * Planner for rules mode: turns a recognised intent into explicit steps over
 * registered tools. A step's input may depend on earlier results; when that
 * dependency cannot be resolved (nothing found, several matches, a failure),
 * the step is skipped with the reason instead of guessing.
 */

export type Skip = { skip: string };
export type StepInput = Record<string, unknown> | ((done: StepOutcome[]) => Record<string, unknown> | Skip);

export interface PlannedStep {
  tool: string;
  purpose: string;
  input: StepInput;
}

export interface RulePlan {
  steps: PlannedStep[];
  /** Steps added after observing a result (re-planning), e.g. one follow-up per blocked task. */
  expand?: (afterPosition: number, done: StepOutcome[]) => PlannedStep[];
  compose: (done: StepOutcome[]) => Answer;
}

const out = <T>(o: StepOutcome | undefined) => (o?.status === "SUCCEEDED" ? (o.output as T) : null);

type People = { total: number; people: Array<{ employeeId: string; name: string | null }> };
type Projects = { total: number; projects: Array<{ projectId: string; name: string }> };
type Tasks = {
  total: number;
  tasks: Array<{ taskId: string; number: number; title: string; status: string; assignee: string | null }>;
};

/** Exactly one match (an exact name wins over partial matches), or the reason there isn't one. */
function pickOne<T>(items: T[], name: (t: T) => string | null, query: string, what: string): T | Skip {
  const exact = items.filter((i) => (name(i) ?? "").toLowerCase() === query.toLowerCase());
  if (exact.length === 1) return exact[0]!;
  if (items.length === 1) return items[0]!;
  if (items.length === 0) return { skip: `No ${what} matches “${query}”.` };
  return {
    skip: `${items.length} ${what}s match “${query}” (${items
      .slice(0, 4)
      .map((i) => name(i))
      .join(", ")}); say which one.`,
  };
}

const isSkip = (v: unknown): v is Skip => typeof v === "object" && v !== null && "skip" in v;

const pending = (done: StepOutcome[]): Answer => {
  const prepared = done.filter((d) => d.status === "AWAITING_CONFIRMATION");
  const problems = done.filter((d) => d.status === "FAILED" || d.status === "SKIPPED");
  const lines: string[] = [];
  if (prepared.length)
    lines.push(
      `I prepared ${prepared.length === 1 ? "this change" : `${prepared.length} changes`}. Nothing changes until you confirm ${prepared.length === 1 ? "it" : "each one"} below:\n${prepared
        .map((p) => `• ${p.summary?.replace(/^Prepared: /, "")}`)
        .join("\n")}`,
    );
  if (problems.length)
    lines.push(`Not done:\n${problems.map((p) => `• ${p.error ?? "skipped"}`).join("\n")}`);
  if (!lines.length) lines.push("Nothing needed to be prepared.");
  return { text: lines.join("\n\n"), evidence: [], notes: [] };
};

export function planFor(intent: Intent, hasModel: boolean): RulePlan {
  switch (intent.kind) {
    case "help":
      return { steps: [], compose: () => compose.help() };
    case "briefing":
      return {
        steps: [
          {
            tool: "get_operational_snapshot",
            purpose: "Read live counts and the rule-based briefing",
            input: {},
          },
        ],
        compose: (d) => {
          const s = out<{ today: string; briefing: string[]; metrics: Record<string, number> }>(d[0]);
          if (!s) return failed(d);
          const m = s.metrics;
          return {
            text: `As of ${s.today}: ${m.openTasks} open tasks (${m.overdueTasks} overdue, ${m.blockedTasks} blocked, ${m.dueThisWeek} due this week), ${m.approvalsAwaitingMe} approval${m.approvalsAwaitingMe === 1 ? "" : "s"} waiting for you, ${m.projectsAtRisk} project${m.projectsAtRisk === 1 ? "" : "s"} at risk.\n\n${s.briefing.map((b) => `• ${b}`).join("\n")}`,
            evidence: [],
            notes: [],
          };
        },
      };
    case "priorities":
      return {
        steps: [
          {
            tool: "analyze_priorities",
            purpose: "Rank your tasks, approvals and projects by the documented rules",
            input: { limit: 10 },
          },
        ],
        compose: (d) => {
          const r = out<Awaited<ReturnType<typeof prioritize>>>(d[0]);
          return r ? compose.priorities(r) : failed(d);
        },
      };
    case "overdue":
      return {
        steps: [
          {
            tool: "analyze_overdue_tasks",
            purpose: intent.mine ? "Rank your overdue tasks by urgency" : "Rank overdue tasks by urgency",
            input: { mine: intent.mine, limit: 10 },
          },
        ],
        compose: (d) => {
          const r = out<Awaited<ReturnType<typeof overdueTasks>>>(d[0]);
          return r ? compose.overdue(r, intent.mine) : failed(d);
        },
      };
    case "blocked_projects":
      return {
        steps: [
          {
            tool: "analyze_blocked_work",
            purpose: "Check projects for blocked tasks, holds and overdue work",
            input: {},
          },
        ],
        compose: (d) => {
          const r = out<Awaited<ReturnType<typeof blockedWork>>>(d[0]);
          return r ? compose.blocked(r) : failed(d);
        },
      };
    case "approvals":
      return {
        steps: [
          {
            tool: "list_my_approvals",
            purpose: "List requests waiting for your decision",
            input: { box: "inbox", pendingOnly: true },
          },
        ],
        compose: (d) => {
          const r = out<{
            total: number;
            requests: Array<{
              approvalId: string;
              title: string;
              requester: string;
              type: string;
              submittedAt: string;
            }>;
          }>(d[0]);
          if (!r) return failed(d);
          if (r.total === 0)
            return { text: "No approval requests are waiting for your decision.", evidence: [], notes: [] };
          return {
            text: `${r.total} request${r.total === 1 ? " is" : "s are"} waiting for your decision:\n${r.requests
              .map(
                (a, n) =>
                  `${n + 1}. ${a.title} (${label(a.type as "GENERAL")}) from ${a.requester}, submitted ${String(a.submittedAt).slice(0, 10)}`,
              )
              .join("\n")}`,
            evidence: r.requests.map((a) => ({
              kind: "approval" as const,
              id: a.approvalId,
              label: a.title,
              link: `/approvals/${a.approvalId}`,
            })),
            notes: [],
          };
        },
      };
    case "my_tasks":
      return {
        steps: [
          {
            tool: "list_tasks",
            purpose: "List your open tasks by due date",
            input: { mine: true, statuses: ["TODO", "IN_PROGRESS", "BLOCKED", "REVIEW"], limit: 20 },
          },
        ],
        compose: (d) => {
          const r = out<{
            total: number;
            tasks: Array<{
              taskId: string;
              number: number;
              title: string;
              status: string;
              priority: string;
              dueDate: string | null;
            }>;
          }>(d[0]);
          if (!r) return failed(d);
          if (r.total === 0)
            return { text: "You have no open tasks assigned to you.", evidence: [], notes: [] };
          return {
            text: `${r.total} open task${r.total === 1 ? "" : "s"} assigned to you:\n${r.tasks
              .map(
                (t) =>
                  `• #${t.number} ${t.title} — ${label(t.status as "TODO")}, ${label(t.priority as "LOW")}${t.dueDate ? `, due ${t.dueDate}` : ""}`,
              )
              .join("\n")}`,
            evidence: r.tasks.map((t) => ({
              kind: "task" as const,
              id: t.taskId,
              label: `#${t.number} ${t.title}`,
              link: `/tasks/${t.taskId}`,
            })),
            notes: r.total > r.tasks.length ? [`Showing ${r.tasks.length} of ${r.total}.`] : [],
          };
        },
      };
    case "trends":
      return {
        steps: [{ tool: "get_weekly_trends", purpose: "Read measured week-over-week trends", input: {} }],
        compose: (d) => {
          const r = out<{ notable: string[]; rolling: Record<string, unknown> }>(d[0]);
          if (!r) return failed(d);
          return {
            text: r.notable.length
              ? `Measured changes (facts, not causes):\n${r.notable.map((n) => `• ${n}`).join("\n")}`
              : "Nothing changed notably week over week. The Insights page has the full series.",
            evidence: [],
            notes: [],
          };
        },
      };
    case "next_steps":
      return {
        steps: [
          {
            tool: "list_projects",
            purpose: `Find the project “${intent.project}”`,
            input: { search: intent.project, limit: 5 },
          },
          {
            tool: "suggest_next_steps",
            purpose: "Apply the resolution rules to its tasks",
            input: (d) => {
              const r = out<Projects>(d[0]);
              if (!r) return { skip: "The project lookup failed." };
              const p = pickOne(r.projects, (x) => x.name, intent.project, "project");
              return isSkip(p) ? p : { projectId: p.projectId };
            },
          },
        ],
        compose: (d) => {
          const r = out<Awaited<ReturnType<typeof resolutionSteps>>>(d[1]);
          return r ? compose.nextSteps(r) : failed(d);
        },
      };
    case "follow_up_blocked": {
      const steps: PlannedStep[] = [];
      if (intent.project)
        steps.push({
          tool: "list_projects",
          purpose: `Find the project “${intent.project}”`,
          input: { search: intent.project, limit: 5 },
        });
      const projectAt = intent.project ? 0 : -1;
      steps.push({
        tool: "list_tasks",
        purpose: "Find tasks marked Blocked",
        input: (d) => {
          if (projectAt < 0) return { statuses: ["BLOCKED"], limit: 50 };
          const r = out<Projects>(d[projectAt]);
          if (!r) return { skip: "The project lookup failed." };
          const p = pickOne(r.projects, (x) => x.name, intent.project!, "project");
          return isSkip(p) ? p : { statuses: ["BLOCKED"], projectId: p.projectId, limit: 50 };
        },
      });
      const listAt = steps.length - 1;
      return {
        steps,
        expand: (position, d) => {
          if (position !== listAt) return [];
          const r = out<{
            tasks: Array<{
              number: number;
              title: string;
              projectId: string | null;
              assigneeEmployeeId: string | null;
            }>;
          }>(d[listAt]);
          if (!r) return [];
          return r.tasks.slice(0, 5).map((t) => ({
            tool: "create_task",
            purpose: `Prepare a follow-up for blocked #${t.number}`,
            input: () => ({
              title: `Follow up on blocked #${t.number}: ${t.title}`.slice(0, 200),
              description: `Task #${t.number} is marked Blocked. Find out what blocks it and agree the next step.`,
              priority: "HIGH",
              dueDate: addDaysISO(todayISO(), 2),
              // Same owner and project as the blocked task, so the follow-up lands with whoever can act.
              ...(t.assigneeEmployeeId ? { assigneeEmployeeId: t.assigneeEmployeeId } : {}),
              ...(t.projectId ? { projectId: t.projectId } : {}),
            }),
          }));
        },
        compose: (d) => {
          const r = out<Tasks>(d[listAt]);
          if (!r) return failed(d);
          if (r.total === 0)
            return {
              text: "No tasks are marked Blocked, so there is nothing to follow up.",
              evidence: [],
              notes: [],
            };
          const a = pending(d.slice(listAt + 1));
          if (r.total > 5)
            a.notes.push(
              `Prepared follow-ups for 5 of ${r.total} blocked tasks (at most 5 changes per request).`,
            );
          return a;
        },
      };
    }
    case "create_task": {
      const steps: PlannedStep[] = [];
      const peopleAt = intent.assignee
        ? steps.push({
            tool: "search_people",
            purpose: `Find “${intent.assignee}” in the directory`,
            input: { query: intent.assignee, limit: 5 },
          }) - 1
        : -1;
      const projectAt = intent.project
        ? steps.push({
            tool: "list_projects",
            purpose: `Find the project “${intent.project}”`,
            input: { search: intent.project, limit: 5 },
          }) - 1
        : -1;
      steps.push({
        tool: "create_task",
        purpose: `Prepare the task “${intent.title}”`,
        input: (d) => {
          const input: Record<string, unknown> = {
            title: intent.title,
            priority: intent.priority ?? "MEDIUM",
          };
          if (intent.dueDate) input.dueDate = intent.dueDate;
          if (peopleAt >= 0) {
            const r = out<People>(d[peopleAt]);
            if (!r) return { skip: "The directory lookup failed." };
            const p = pickOne(r.people, (x) => x.name, intent.assignee!, "person");
            if (isSkip(p)) return p;
            input.assigneeEmployeeId = p.employeeId;
          }
          if (projectAt >= 0) {
            const r = out<Projects>(d[projectAt]);
            if (!r) return { skip: "The project lookup failed." };
            const p = pickOne(r.projects, (x) => x.name, intent.project!, "project");
            if (isSkip(p)) return p;
            input.projectId = p.projectId;
          }
          return input;
        },
      });
      return { steps, compose: (d) => pending(d) };
    }
    case "set_status":
      return {
        steps: [
          {
            tool: "list_tasks",
            purpose: `Find task #${intent.taskNumber}`,
            input: { search: String(intent.taskNumber), limit: 5 },
          },
          {
            tool: "update_task_status",
            purpose: `Prepare moving #${intent.taskNumber} to “${label(intent.status)}”`,
            input: (d) => {
              const r = out<Tasks>(d[0]);
              if (!r) return { skip: "The task lookup failed." };
              const t = r.tasks.find((x) => x.number === intent.taskNumber);
              if (!t) return { skip: `No task #${intent.taskNumber} that you can see.` };
              if (t.status === intent.status)
                return { skip: `#${t.number} is already “${label(intent.status)}”.` };
              return { taskId: t.taskId, status: intent.status };
            },
          },
        ],
        compose: (d) => pending(d.slice(1)),
      };
    case "remember":
      return {
        steps: [
          { tool: "save_preference", purpose: "Save your preference", input: { content: intent.content } },
        ],
        compose: (d) =>
          d[0]?.status === "SUCCEEDED"
            ? {
                text: `Saved. I'll take this preference into account${hasModel ? "" : " where my rules use it"}: “${intent.content}”. You can see and delete saved preferences under Memory.`,
                evidence: [],
                notes: [],
              }
            : failed(d),
      };
    case "mark_notifications_read":
      return {
        steps: [
          {
            tool: "mark_notifications_read",
            purpose: "Mark your unread notifications as read (low risk, your own inbox)",
            input: {},
          },
        ],
        compose: (d) => {
          const r = out<{ updated: number }>(d[0]);
          return r
            ? {
                text: r.updated
                  ? `Marked ${r.updated} notification${r.updated === 1 ? "" : "s"} as read.`
                  : "You had no unread notifications.",
                evidence: [],
                notes: [],
              }
            : failed(d);
        },
      };
  }
}

function failed(d: StepOutcome[]): Answer {
  const problems = d.filter((x) => x.status !== "SUCCEEDED").map((x) => x.error ?? "Not completed");
  return {
    text: `I couldn't complete this: ${problems.join("; ") || "a step did not finish"}.`,
    evidence: [],
    notes: [],
  };
}

export type { Evidence };
