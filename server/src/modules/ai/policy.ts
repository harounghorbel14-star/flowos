import { can, type Actor } from "../../lib/actor";
import type { ToolDef } from "./tools";

/**
 * The one place that decides what the agent may do with a tool. Nothing the
 * user or a model writes can change these rules or the user's permissions: a
 * tool is evaluated against the requesting user's current role every time.
 */

export const LIMITS = {
  /** Steps (tool calls) per run, planned or added while re-planning. */
  maxSteps: 12,
  /** Writes (prepared or automatic) per run. */
  maxWritesPerRun: 5,
  /** Model requests per run (model mode). */
  maxModelRequests: 8,
  /** Per-step execution timeout. */
  stepTimeoutMs: 15_000,
  /** Wall-clock budget for a whole run. */
  runBudgetMs: 120_000,
  /** Extra attempts for a read that failed for a transient reason. Writes are never retried automatically. */
  maxReadRetries: 2,
  /** A prepared action must be confirmed within this window. */
  actionTtlMs: 10 * 60 * 1000,
} as const;

/**
 * Operations the agent never performs, whatever the role: they stay in the
 * regular interface, where the person acts directly. Listed so the boundary is
 * explicit and testable; none of them exists as a tool.
 */
export const NEVER_AUTONOMOUS = [
  "Deleting records (tasks, projects, people, documents, conversations of others)",
  "Changing roles, memberships or permissions",
  "Deciding approval requests",
  "Billing, plan or organization-wide settings",
  "Sending external messages (Slack/Teams, email)",
  "Creating, changing or running workflows",
] as const;

export type PolicyDecision =
  | { kind: "run" }
  /** Executed immediately: low-risk and limited to the user's own data. */
  | { kind: "auto" }
  /** Prepared; executes only when the user confirms this exact input. */
  | { kind: "confirm" }
  | { kind: "deny"; reason: string };

export function decide(
  actor: Actor,
  tool: ToolDef | undefined,
  run: { writes: number; steps: number },
): PolicyDecision {
  if (!tool) return { kind: "deny", reason: "This tool is not available." };
  if (!can(actor, "ai:use")) return { kind: "deny", reason: "Your role does not allow the assistant." };
  if (!tool.permissions.every((p) => can(actor, p)))
    return { kind: "deny", reason: "Your role does not allow this." };
  if (tool.risk === "high")
    return { kind: "deny", reason: "High-impact operations are done in the app, not by the assistant." };
  if (run.steps >= LIMITS.maxSteps)
    return { kind: "deny", reason: `Step limit reached (${LIMITS.maxSteps} per request).` };
  if (tool.risk === "read") return { kind: "run" };
  if (run.writes >= LIMITS.maxWritesPerRun)
    return { kind: "deny", reason: `At most ${LIMITS.maxWritesPerRun} changes per request.` };
  return tool.risk === "low" ? { kind: "auto" } : { kind: "confirm" };
}

/** Whether a failure is worth one more attempt: only unexpected (non-domain) errors on reads. */
export function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AppError" || "code" in err) {
    const code = (err as { code?: unknown }).code;
    // Postgres serialization / deadlock / connection errors are transient; domain errors are not.
    return typeof code === "string" && /^(40001|40P01|57P0[1-3]|08\d{3})$/.test(code);
  }
  return err.name === "StepTimeoutError" || /ECONNRESET|ETIMEDOUT|EPIPE/.test(err.message);
}
