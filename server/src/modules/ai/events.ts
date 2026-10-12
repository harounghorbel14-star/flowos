import type { RunReport, StepView } from "./runs";

/** NDJSON events streamed for one user message. Each reflects something that already happened. */
export type TurnEvent =
  | {
      type: "run";
      run: {
        id: string;
        mode: "rules" | "model";
        model: string | null;
        objective: string;
        intent: string | null;
      };
    }
  | { type: "plan"; steps: StepView[] }
  | { type: "step"; step: StepView }
  | { type: "text"; delta: string }
  /** Kept for older clients: one line per tool call with its outcome. */
  | { type: "tool"; name: string; outcome: "OK" | "ERROR" | "DENIED" | "INVALID" | "PROPOSED" }
  | {
      type: "action";
      action: { id: string; toolName: string; summary: string; inputHash: string; expiresAt: Date };
    }
  | { type: "report"; report: RunReport }
  | { type: "done"; stopReason: string | null }
  | { type: "error"; message: string; kind?: "model_unavailable" | "tool" | "limit" | "internal" };

export type Emit = (e: TurnEvent) => void;
