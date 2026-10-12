import {
  AlertTriangle,
  Ban,
  Brain,
  Check,
  CheckCircle2,
  Circle,
  Hand,
  MessageSquarePlus,
  Minus,
  RotateCw,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { LogoMark } from "../components/brand";
import { useToast } from "../components/toast";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  SkeletonRows,
} from "../components/ui";
import { timeAgo } from "../lib/format";
import { errorMessage, getActiveOrgId, trpc, type RouterOutputs } from "../lib/trpc";

type Conversation = RouterOutputs["ai"]["conversation"];
type Action = Conversation["actions"][number];
type Run = Conversation["runs"][number];
type Step = Run["steps"][number];
type Report = NonNullable<Run["report"]>;
type Status = RouterOutputs["ai"]["status"];

type StreamEvent =
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
  | { type: "plan"; steps: Step[] }
  | { type: "step"; step: Step }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; outcome: string }
  | { type: "action"; action: { id: string } }
  | { type: "report"; report: Report }
  | { type: "done"; stopReason: string | null }
  | { type: "error"; message: string; kind?: string };

/** What the stream has told us so far. Nothing here is assumed: each field mirrors an event. */
interface Live {
  run: {
    id: string;
    mode: "rules" | "model";
    model: string | null;
    objective: string;
    intent: string | null;
  } | null;
  steps: Step[];
  text: string;
  report: Report | null;
}

const SUGGESTIONS = [
  "What needs my attention today?",
  "What should I prioritize today?",
  "Which projects are blocked?",
  "What are the most urgent overdue tasks?",
  "Which approvals are waiting for me?",
];

/** POST a message and stream NDJSON events back. */
async function streamTurn(
  conversationId: string,
  text: string,
  onEvent: (e: StreamEvent) => void,
  signal: AbortSignal,
) {
  const res = await fetch(`/api/ai/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-flowos-client": "web",
      "x-flowos-org": getActiveOrgId() ?? "",
    },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status}).`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as StreamEvent);
    }
  }
}

// ─── Run card: objective, plan, step status, results ─────────────────────────

const STEP: Record<Step["status"], { icon: ReactNode; label: string; tone?: string }> = {
  PENDING: { icon: <Circle size={13} aria-hidden />, label: "Planned" },
  RUNNING: { icon: <RotateCw size={13} className="spin" aria-hidden />, label: "Running" },
  SUCCEEDED: { icon: <Check size={13} aria-hidden />, label: "Done", tone: "good" },
  FAILED: { icon: <AlertTriangle size={13} aria-hidden />, label: "Failed", tone: "critical" },
  SKIPPED: { icon: <Minus size={13} aria-hidden />, label: "Skipped" },
  AWAITING_CONFIRMATION: {
    icon: <Hand size={13} aria-hidden />,
    label: "Waiting for you",
    tone: "attention",
  },
  CANCELLED: { icon: <Ban size={13} aria-hidden />, label: "Stopped" },
};

const RUN_STATUS: Record<Run["status"], { label: string; tone?: string }> = {
  RUNNING: { label: "Running" },
  COMPLETED: { label: "Completed", tone: "good" },
  PARTIAL: { label: "Partly completed", tone: "attention" },
  AWAITING_CONFIRMATION: { label: "Waiting for confirmation", tone: "attention" },
  FAILED: { label: "Failed", tone: "critical" },
  CANCELLED: { label: "Stopped" },
};

function StepRow({ step }: { step: Step }) {
  const s = STEP[step.status];
  return (
    <li className={["run-step", s.tone].filter(Boolean).join(" ")}>
      <span className="run-step-icon" title={s.label}>
        {s.icon}
      </span>
      <div className="grow">
        <div>
          {step.purpose}
          {!step.planned ? <span className="run-tag">added after observing results</span> : null}
        </div>
        <div className="run-step-detail">
          <span className="sr-only">{s.label}. </span>
          {step.status === "SUCCEEDED" || step.status === "AWAITING_CONFIRMATION"
            ? step.resultSummary
            : (step.error ?? (step.status === "RUNNING" ? "Running…" : null))}
          {step.attempts > 1 ? ` · ${step.attempts} attempts` : null}
          {step.verified ? (
            <span className="run-verified">
              <ShieldCheck size={12} aria-hidden /> verified
            </span>
          ) : null}
        </div>
      </div>
      <code className="run-step-tool">{step.tool}</code>
    </li>
  );
}

function RunCard({
  run,
  steps,
  report,
  live,
}: {
  run: {
    mode: "rules" | "model";
    model: string | null;
    objective: string;
    intent?: string | null;
    status?: Run["status"];
  };
  steps: Step[];
  report: Report | null;
  live?: boolean;
}) {
  const status = report?.status ?? run.status;
  // Rules mode with no recognised command did nothing: say so rather than "Completed".
  const notUnderstood = run.mode === "rules" && run.intent === null && steps.length === 0;
  const s =
    status && !live
      ? notUnderstood
        ? { label: "Not understood", tone: undefined }
        : status === "COMPLETED" && report?.grounded === false
          ? // The model answered without consulting any record: never presented as a success.
            { label: "Unverified answer", tone: "attention" }
          : RUN_STATUS[status]
      : null;
  return (
    <section className="run-card" aria-label={`Run: ${run.objective}`}>
      <div className="run-head">
        <span
          className="run-mode"
          title={
            run.mode === "rules"
              ? "Planned and executed by FLOWOS rules"
              : "Planned with a language model; executed by FLOWOS"
          }
        >
          {run.mode === "rules" ? <ShieldCheck size={13} aria-hidden /> : <Brain size={13} aria-hidden />}
          {run.mode === "rules" ? "FLOWOS rules" : `Model · ${run.model ?? "unknown"}`}
        </span>
        <span className="run-objective">{run.objective}</span>
        {s ? <Badge tone={s.tone}>{s.label}</Badge> : live ? <LogoMark size={16} state="working" /> : null}
      </div>
      {steps.length ? (
        <ol className="run-steps">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ol>
      ) : null}
      {report?.notes.length ? (
        <ul className="run-notes">
          {report.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {report?.evidence.length ? (
        <div className="run-evidence">
          <span className="faint">Based on:</span>
          {report.evidence.slice(0, 8).map((e) => (
            <Link key={`${e.kind}-${e.id}`} to={e.link}>
              {e.label}
            </Link>
          ))}
          {report.evidence.length > 8 ? (
            <span className="faint">+{report.evidence.length - 8} more</span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ActionCard({ action, onChanged }: { action: Action; onChanged(): void }) {
  const toast = useToast();
  const confirm = trpc.ai.confirmAction.useMutation({
    onSuccess: (r) => {
      // Only the backend's answer decides what the person is told.
      if (r.status === "EXECUTED")
        toast.success(r.verified ? `Done and verified: ${action.summary}` : `Done: ${action.summary}`);
      else toast.error(new Error(r.error ?? "The action failed."));
      onChanged();
    },
    onError: (e) => {
      toast.error(e);
      onChanged();
    },
  });
  const reject = trpc.ai.rejectAction.useMutation({ onSuccess: onChanged, onError: toast.error });
  const expired = action.status === "PROPOSED" && new Date(action.expiresAt).getTime() < Date.now();
  const tone = {
    PROPOSED: "attention",
    EXECUTED: "good",
    REJECTED: undefined,
    FAILED: "critical",
    EXPIRED: undefined,
  }[action.status];
  const statusLabel = expired
    ? "Expired"
    : {
        PROPOSED: "Waiting for you",
        EXECUTED: "Executed",
        REJECTED: "Rejected",
        FAILED: "Failed",
        EXPIRED: "Expired",
      }[action.status];
  return (
    <div
      className={[
        "panel panel-body action-card",
        action.status === "PROPOSED" && !expired ? "waiting" : "",
        action.status === "EXECUTED" ? "executed" : "",
        action.status === "FAILED" ? "failed" : "",
      ].join(" ")}
    >
      <div className="spread" style={{ alignItems: "flex-start" }}>
        <div>
          <p className="eyebrow" style={{ marginBottom: 4 }}>
            Prepared action — nothing changes until you confirm
          </p>
          <strong>{action.summary}</strong>
          {action.status === "EXECUTED" ? (
            <div className="action-result good">
              <CheckCircle2 size={14} aria-hidden /> Applied{action.verified ? " and verified" : ""}
            </div>
          ) : null}
          {action.error ? (
            <div className="action-result critical">
              <AlertTriangle size={14} aria-hidden /> {action.error}
            </div>
          ) : null}
          {action.status === "EXECUTED" && action.result && typeof action.result.taskId === "string" ? (
            <div style={{ fontSize: 13 }}>
              <Link to={`/tasks/${action.result.taskId}`}>Open task</Link>
            </div>
          ) : null}
        </div>
        <Badge tone={expired ? undefined : tone}>{statusLabel}</Badge>
      </div>
      {action.status === "PROPOSED" && !expired ? (
        <div className="row" style={{ marginTop: 10 }}>
          <Button
            variant="accent"
            size="sm"
            loading={confirm.isPending}
            onClick={() => confirm.mutate({ actionId: action.id, inputHash: action.inputHash })}
          >
            <Check aria-hidden /> Confirm
          </Button>
          <Button size="sm" loading={reject.isPending} onClick={() => reject.mutate({ actionId: action.id })}>
            <X aria-hidden /> Reject
          </Button>
          <span className="faint" style={{ fontSize: 12 }}>
            Expires {timeAgo(action.expiresAt)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

// ─── Transcript ──────────────────────────────────────────────────────────────

type Item = Conversation["items"][number];
type Block = { kind: "legacy"; item: Item } | { kind: "run"; runId: string; items: Item[] };

/** Group the transcript by run; messages recorded before runs existed are shown as they were. */
function blocksOf(items: Item[], runs: Run[]): Block[] {
  const blocks: Block[] = [];
  const byRun = new Map<string, Extract<Block, { kind: "run" }>>();
  for (const item of items) {
    if (!item.runId) {
      blocks.push({ kind: "legacy", item });
      continue;
    }
    let b = byRun.get(item.runId);
    if (!b) {
      b = { kind: "run", runId: item.runId, items: [] };
      byRun.set(item.runId, b);
      blocks.push(b);
    }
    b.items.push(item);
  }
  // A run with no messages of its own (none today) would still be shown after its predecessor.
  for (const r of runs) if (!byRun.has(r.id)) blocks.push({ kind: "run", runId: r.id, items: [] });
  return blocks;
}

function Transcript({ id, status }: { id: string; status: Status | undefined }) {
  const utils = trpc.useUtils();
  const convo = trpc.ai.conversation.useQuery({ id });
  const [draft, setDraft] = useState("");
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [convo.data?.items.length, live?.text, live?.steps.length, convo.data?.actions.length]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const refresh = () =>
    Promise.all([
      utils.ai.conversation.invalidate({ id }),
      utils.ai.conversations.invalidate(),
      utils.ai.memories.invalidate(),
    ]);

  const send = async (text: string) => {
    if (!text.trim() || live) return;
    setDraft("");
    setError(null);
    setStopped(false);
    setLive({ run: null, steps: [], text: "", report: null });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamTurn(
        id,
        text,
        (e) => {
          setLive((l) => {
            if (!l) return l;
            switch (e.type) {
              case "run":
                // A second run in one turn (e.g. FLOWOS rules after the model was unreachable) starts fresh.
                return { run: e.run, steps: [], text: "", report: null };
              case "plan":
                return { ...l, steps: e.steps };
              case "step":
                return {
                  ...l,
                  steps: l.steps.some((s) => s.id === e.step.id)
                    ? l.steps.map((s) => (s.id === e.step.id ? e.step : s))
                    : [...l.steps, e.step],
                };
              case "text":
                return { ...l, text: l.text + e.delta };
              case "report":
                return { ...l, report: e.report };
              default:
                return l;
            }
          });
          if (e.type === "action") void refresh();
          else if (e.type === "error") setError(e.message);
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) setError(errorMessage(err));
    } finally {
      setLive(null);
      await refresh();
    }
  };

  if (convo.error) return <ErrorState error={convo.error} />;
  if (!convo.data) return <SkeletonRows rows={4} />;
  const data = convo.data;
  const runs = new Map(data.runs.map((r) => [r.id, r]));
  const actionsByRun = new Map<string, Action[]>();
  for (const a of data.actions)
    if (a.runId) actionsByRun.set(a.runId, [...(actionsByRun.get(a.runId) ?? []), a]);
  const legacyActions = new Map(data.actions.filter((a) => !a.runId).map((a) => [a.toolUseId, a]));
  const empty = data.items.length === 0 && !live;
  const ruleOnly = !status?.runtime;

  return (
    <div className="stack" style={{ gap: 14 }}>
      {empty ? (
        <div className="panel panel-body">
          <p className="muted" style={{ marginTop: 0 }}>
            {ruleOnly
              ? "No language model is configured, so FLOWOS answers with its own rules: it plans the steps, reads your live records, and shows each step and its evidence. Try one of these:"
              : "Ask about your organization’s live data. FLOWOS checks every step against your permissions and shows what actually happened; you confirm every change yourself."}
          </p>
          <div className="row">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="chip-toggle" onClick={() => void send(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {blocksOf(data.items, data.runs).map((block, i) => {
        if (block.kind === "legacy") {
          const item = block.item;
          if (item.kind === "tool") {
            const action = legacyActions.get(item.toolUseId);
            return action ? <ActionCard key={i} action={action} onChanged={() => void refresh()} /> : null;
          }
          return (
            <div key={i} className={item.kind === "user" ? "chat-bubble user" : "chat-bubble assistant"}>
              <div className="prose">{item.text}</div>
            </div>
          );
        }
        const run = runs.get(block.runId);
        const user = block.items.filter((x) => x.kind === "user");
        const answers = block.items.filter((x) => x.kind === "assistant");
        return (
          <Fragment key={block.runId}>
            {user.map((u, j) => (
              <div key={`u${j}`} className="chat-bubble user">
                <div className="prose">{u.kind === "user" ? u.text : null}</div>
              </div>
            ))}
            {run ? <RunCard run={run} steps={run.steps} report={run.report} /> : null}
            {answers.map((a, j) => (
              <div key={`a${j}`} className="chat-bubble assistant">
                <div className="prose">{a.kind === "assistant" ? a.text : null}</div>
              </div>
            ))}
            {(actionsByRun.get(block.runId) ?? []).map((a) => (
              <ActionCard key={a.id} action={a} onChanged={() => void refresh()} />
            ))}
          </Fragment>
        );
      })}
      {live ? (
        <>
          {live.run ? (
            <RunCard run={live.run} steps={live.steps} report={live.report} live={!live.report} />
          ) : null}
          <div className="chat-bubble assistant">
            {live.text ? (
              <div className="prose">{live.text}</div>
            ) : (
              // Only while a reply is genuinely on its way (no text yet).
              <LogoMark size={18} state="working" className="assistant-working" />
            )}
          </div>
        </>
      ) : null}
      {/* One short announcement per turn instead of re-reading the growing text. */}
      <span className="sr-only" role="status">
        {live ? "The assistant is working on your request." : ""}
      </span>
      {stopped ? (
        <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
          Stopped. Steps that had not run were cancelled; nothing else was changed.
        </p>
      ) : null}
      {error ? <div className="form-error">{error}</div> : null}
      <div ref={endRef} />
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <label className="sr-only" htmlFor="chat-draft">
          Message
        </label>
        <textarea
          id="chat-draft"
          className="textarea"
          rows={2}
          maxLength={4000}
          placeholder={
            ruleOnly
              ? "Try “What should I prioritize today?” or “help”"
              : "Ask about tasks, projects, people, approvals…"
          }
          value={draft}
          disabled={Boolean(live)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
        />
        {live ? (
          <Button
            type="button"
            icon
            aria-label="Stop"
            title="Stop the answer"
            onClick={() => {
              abortRef.current?.abort();
              setStopped(true);
            }}
          >
            <Square aria-hidden />
          </Button>
        ) : (
          <Button type="submit" variant="primary" icon aria-label="Send" disabled={!draft.trim()}>
            <Send aria-hidden />
          </Button>
        )}
      </form>
      {data.usage && data.usage.requests > 0 ? (
        <p className="faint" style={{ fontSize: 12, margin: 0 }}>
          {data.usage.requests} model requests · {data.usage.inputTokens + data.usage.outputTokens} tokens (
          {data.usage.cacheReadTokens} from cache)
        </p>
      ) : null}
    </div>
  );
}

// ─── Runtime status and memory ───────────────────────────────────────────────

function RuntimeBanner({ status }: { status: Status }) {
  const r = status.runtime;
  return (
    <div className="panel panel-body runtime-banner">
      {r ? (
        <p style={{ margin: 0 }}>
          <Brain size={15} aria-hidden /> <strong>Model:</strong> {r.model} ·{" "}
          {r.hosting === "self-hosted" ? "self-hosted runtime" : "hosted API (third-party)"} ·{" "}
          {r.reachable ? (
            <span className="good">reachable</span>
          ) : (
            <span className="critical">
              not reachable{r.detail ? ` (${r.detail})` : ""}: supported commands fall back to FLOWOS rules
            </span>
          )}
          {!status.includedInPlan ? " · not included in your plan, so FLOWOS rules answer instead" : null}
          <br />
          <span className="faint">
            {status.routing === "rules-first"
              ? "Supported commands are planned and answered by FLOWOS rules; the model handles other requests."
              : "The model plans every request; FLOWOS validates and executes each step."}
          </span>
        </p>
      ) : (
        <p style={{ margin: 0 }}>
          <ShieldCheck size={15} aria-hidden /> <strong>FLOWOS rules mode.</strong> No language model is
          configured. Supported commands are planned and answered from your live records; other questions need
          an inference model on the server.
          {status.configError ? (
            <span className="critical"> Configuration problem: {status.configError}</span>
          ) : null}
        </p>
      )}
      <details>
        <summary>What works without a model, and what the assistant never does</summary>
        <div className="grid two" style={{ marginTop: 8 }}>
          <ul className="plain">
            {status.supportedCommands.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <ul className="plain">
            {status.neverAutonomous.map((c) => (
              <li key={c}>
                <Ban size={12} aria-hidden /> {c}
              </li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  );
}

function MemoryPanel() {
  const toast = useToast();
  const utils = trpc.useUtils();
  const memories = trpc.ai.memories.useQuery();
  const [draft, setDraft] = useState("");
  const [orgDraft, setOrgDraft] = useState("");
  const [clearing, setClearing] = useState(false);
  const invalidate = () => utils.ai.memories.invalidate();
  const add = trpc.ai.addMemory.useMutation({
    onSuccess: async (_r, vars) => {
      if (vars.scope === "PREFERENCE") setDraft("");
      else setOrgDraft("");
      await invalidate();
    },
    onError: toast.error,
  });
  const remove = trpc.ai.deleteMemory.useMutation({ onSuccess: invalidate, onError: toast.error });
  const clear = trpc.ai.clearMyMemory.useMutation({
    onSuccess: async (r) => {
      setClearing(false);
      toast.success(`Removed ${r.removed} personal ${r.removed === 1 ? "entry" : "entries"}.`);
      await invalidate();
    },
    onError: toast.error,
  });
  const data = memories.data;
  const group = (scope: string) => data?.items.filter((m) => m.scope === scope) ?? [];
  const section = (
    title: string,
    scope: string,
    deletable: (m: { mine: boolean | null }) => boolean,
    hint: string,
  ) => (
    <div className="memory-section">
      <p className="eyebrow">{title}</p>
      {group(scope).length === 0 ? <p className="faint memory-empty">{hint}</p> : null}
      <ul className="plain">
        {group(scope).map((m) => (
          <li key={m.id} className="memory-item">
            <span className="grow">{m.content}</span>
            {deletable(m) ? (
              <Button
                size="sm"
                variant="ghost"
                icon
                aria-label={`Delete: ${m.content}`}
                onClick={() => remove.mutate({ id: m.id })}
              >
                <Trash2 aria-hidden />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <Panel title="Memory">
      {memories.error ? <ErrorState error={memories.error} /> : null}
      {data ? (
        <div className="stack" style={{ gap: 12 }}>
          {section("Your preferences", "PREFERENCE", () => true, "Say “remember …” or add one below.")}
          {section(
            "Organization knowledge",
            "ORG_KNOWLEDGE",
            () => data.canManageOrgKnowledge,
            "Written by people who manage the organization.",
          )}
          {section(
            "Verified outcomes",
            "OUTCOME",
            () => true,
            `Changes the assistant made and verified; kept ${data.retention.outcomeDays} days.`,
          )}
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) add.mutate({ scope: "PREFERENCE", content: draft });
            }}
          >
            <label className="sr-only" htmlFor="memory-pref">
              New preference
            </label>
            <input
              id="memory-pref"
              className="input grow"
              maxLength={500}
              placeholder="Add a preference"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              loading={add.isPending && add.variables?.scope === "PREFERENCE"}
              disabled={!draft.trim()}
            >
              Save
            </Button>
          </form>
          {data.canManageOrgKnowledge ? (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                if (orgDraft.trim()) add.mutate({ scope: "ORG_KNOWLEDGE", content: orgDraft });
              }}
            >
              <label className="sr-only" htmlFor="memory-org">
                New organization knowledge
              </label>
              <input
                id="memory-org"
                className="input grow"
                maxLength={500}
                placeholder="Add organization knowledge"
                value={orgDraft}
                onChange={(e) => setOrgDraft(e.target.value)}
              />
              <Button
                type="submit"
                size="sm"
                loading={add.isPending && add.variables?.scope === "ORG_KNOWLEDGE"}
                disabled={!orgDraft.trim()}
              >
                Save
              </Button>
            </form>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setClearing(true)}>
            Clear my memory
          </Button>
        </div>
      ) : (
        <SkeletonRows rows={2} />
      )}
      <ConfirmDialog
        open={clearing}
        onClose={() => setClearing(false)}
        title="Clear your assistant memory?"
        body="Your saved preferences and verified outcomes in this organization are deleted. Organization knowledge and your conversations are kept."
        confirmLabel="Clear memory"
        danger
        loading={clear.isPending}
        onConfirm={() => clear.mutate()}
      />
    </Panel>
  );
}

export function AssistantPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const utils = trpc.useUtils();
  const status = trpc.ai.status.useQuery();
  const conversations = trpc.ai.conversations.useQuery(undefined, { enabled: Boolean(status.data) });
  const create = trpc.ai.createConversation.useMutation({
    onSuccess: async (c) => {
      await utils.ai.conversations.invalidate();
      navigate(`/assistant/${c.id}`);
    },
    onError: toast.error,
  });
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);
  const remove = trpc.ai.deleteConversation.useMutation({
    onSuccess: async (_r, vars) => {
      await utils.ai.conversations.invalidate();
      setDeleting(null);
      toast.success("Conversation deleted.");
      if (vars.id === id) navigate("/assistant");
    },
    onError: toast.error,
  });

  return (
    <>
      <PageHeader
        eyebrow="Assist"
        title="Assistant"
        lede="FLOWOS plans each request, runs it against your live records with your permissions, and shows every step. Every change waits for your confirmation."
        actions={
          status.data ? (
            <Button variant="primary" loading={create.isPending} onClick={() => create.mutate({})}>
              <MessageSquarePlus aria-hidden /> New conversation
            </Button>
          ) : null
        }
      />
      {status.isLoading ? <SkeletonRows rows={3} /> : null}
      {status.error ? <ErrorState error={status.error} onRetry={() => void status.refetch()} /> : null}
      {status.data ? <RuntimeBanner status={status.data} /> : null}
      {status.data ? (
        <div className="grid assistant-layout">
          <div className="stack" style={{ gap: 16 }}>
            <Panel title="Conversations" flush>
              {conversations.data && conversations.data.length === 0 ? (
                <EmptyState compact title="No conversations yet" />
              ) : null}
              <ul className="list">
                {(conversations.data ?? []).map((c) => (
                  <li key={c.id}>
                    <div
                      className="list-item"
                      style={{ background: c.id === id ? "var(--paper-sunk)" : undefined }}
                    >
                      <a
                        href={`/assistant/${c.id}`}
                        className="grow truncate"
                        style={{ textDecoration: "none" }}
                        onClick={(e) => {
                          e.preventDefault();
                          navigate(`/assistant/${c.id}`);
                        }}
                      >
                        {c.title}
                        <div className="faint" style={{ fontSize: 12 }}>
                          {timeAgo(c.updatedAt)}
                        </div>
                      </a>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon
                        aria-label={`Delete ${c.title}`}
                        onClick={() => setDeleting({ id: c.id, title: c.title })}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
            <MemoryPanel />
          </div>
          {id ? (
            <Transcript key={id} id={id} status={status.data} />
          ) : (
            <div className="panel">
              <EmptyState
                icon={<Sparkles size={18} />}
                title="Start a conversation"
                action={
                  <Button variant="primary" onClick={() => create.mutate({})}>
                    New conversation
                  </Button>
                }
              >
                Try “What should I prioritize today?”
              </EmptyState>
            </div>
          )}
        </div>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete this conversation?"
        body={`“${deleting?.title ?? ""}”, its messages and its run history are deleted. This cannot be undone; tasks it already created or updated are kept.`}
        confirmLabel="Delete conversation"
        danger
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate({ id: deleting.id })}
      />
    </>
  );
}
