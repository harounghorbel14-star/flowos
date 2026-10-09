import { Check, MessageSquarePlus, Search, Send, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useToast } from "../components/toast";
import { Badge, Button, EmptyState, ErrorState, PageHeader, Panel, SkeletonRows } from "../components/ui";
import { timeAgo } from "../lib/format";
import { errorMessage, getActiveOrgId, trpc, type RouterOutputs } from "../lib/trpc";

type Conversation = RouterOutputs["ai"]["conversation"];
type Action = Conversation["actions"][number];

type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; outcome: string }
  | { type: "action"; action: { id: string } }
  | { type: "done"; stopReason: string | null }
  | { type: "error"; message: string };

const TOOL_LABELS: Record<string, string> = {
  get_operational_snapshot: "Checked the operational snapshot",
  get_weekly_trends: "Checked weekly trends",
  search_people: "Searched people",
  get_person: "Opened a profile",
  list_tasks: "Looked up tasks",
  get_task: "Opened a task",
  list_projects: "Looked up projects",
  list_my_approvals: "Checked approvals",
  search_documents: "Searched documents",
  create_task: "Prepared a new task",
  update_task_status: "Prepared a status change",
};

const SUGGESTIONS = [
  "What needs my attention today?",
  "Which projects are at risk, and why?",
  "What is overdue for me?",
  "Which approvals are waiting for my decision?",
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

function ActionCard({ action, onChanged }: { action: Action; onChanged(): void }) {
  const toast = useToast();
  const confirm = trpc.ai.confirmAction.useMutation({
    onSuccess: (r) => {
      if (r.status === "EXECUTED") toast.success("Done.");
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
      className="panel panel-body"
      style={{
        boxShadow: "none",
        borderColor: action.status === "PROPOSED" && !expired ? "var(--attention)" : undefined,
      }}
    >
      <div className="spread" style={{ alignItems: "flex-start" }}>
        <div>
          <p className="eyebrow" style={{ marginBottom: 4 }}>
            Prepared action — nothing changes until you confirm
          </p>
          <strong>{action.summary}</strong>
          {action.error ? <div style={{ color: "var(--critical)", fontSize: 13 }}>{action.error}</div> : null}
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

function Transcript({ id }: { id: string }) {
  const utils = trpc.useUtils();
  const convo = trpc.ai.conversation.useQuery({ id });
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState<{ text: string; tools: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [convo.data?.items.length, streaming?.text, convo.data?.actions.length]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const refresh = () =>
    Promise.all([utils.ai.conversation.invalidate({ id }), utils.ai.conversations.invalidate()]);

  const send = async (text: string) => {
    if (!text.trim() || streaming) return;
    setDraft("");
    setError(null);
    setStreaming({ text: "", tools: [] });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamTurn(
        id,
        text,
        (e) => {
          if (e.type === "text") setStreaming((s) => (s ? { ...s, text: s.text + e.delta } : s));
          else if (e.type === "tool")
            setStreaming((s) => (s ? { ...s, text: "", tools: [...s.tools, e.name] } : s));
          else if (e.type === "action") void refresh();
          else if (e.type === "error") setError(e.message);
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) setError(errorMessage(err));
    } finally {
      setStreaming(null);
      await refresh();
    }
  };

  if (convo.error) return <ErrorState error={convo.error} />;
  if (!convo.data) return <SkeletonRows rows={4} />;
  const actionsByToolUse = new Map(convo.data.actions.map((a) => [a.toolUseId, a]));
  const empty = convo.data.items.length === 0 && !streaming;

  return (
    <div className="stack" style={{ gap: 14 }}>
      {empty ? (
        <div className="panel panel-body">
          <p className="muted" style={{ marginTop: 0 }}>
            Ask about your organization’s live data. The assistant can look things up and prepare tasks or
            status changes — you confirm every change yourself.
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
      {convo.data.items.map((item, i) => {
        if (item.kind === "tool") {
          const action = actionsByToolUse.get(item.toolUseId);
          return action ? (
            <ActionCard key={i} action={action} onChanged={() => void refresh()} />
          ) : (
            <div key={i} className="faint row" style={{ fontSize: 12.5, gap: 6 }}>
              <Search size={13} aria-hidden /> {TOOL_LABELS[item.name] ?? item.name}
            </div>
          );
        }
        return (
          <div key={i} className={item.kind === "user" ? "chat-bubble user" : "chat-bubble assistant"}>
            <div className="prose">{item.text}</div>
          </div>
        );
      })}
      {streaming ? (
        <>
          {streaming.tools.map((t, i) => (
            <div key={i} className="faint row" style={{ fontSize: 12.5, gap: 6 }}>
              <Search size={13} aria-hidden /> {TOOL_LABELS[t] ?? t}
            </div>
          ))}
          <div className="chat-bubble assistant" aria-live="polite">
            <div className="prose">{streaming.text || <span className="faint">Working…</span>}</div>
          </div>
        </>
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
          placeholder="Ask about tasks, projects, people, approvals…"
          value={draft}
          disabled={Boolean(streaming)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
        />
        <Button
          type="submit"
          variant="primary"
          icon
          aria-label="Send"
          disabled={!draft.trim() || Boolean(streaming)}
        >
          <Send aria-hidden />
        </Button>
      </form>
      {convo.data.usage && convo.data.usage.requests > 0 ? (
        <p className="faint" style={{ fontSize: 12, margin: 0 }}>
          {convo.data.usage.requests} model requests ·{" "}
          {convo.data.usage.inputTokens + convo.data.usage.outputTokens} tokens (
          {convo.data.usage.cacheReadTokens} from cache)
        </p>
      ) : null}
    </div>
  );
}

export function AssistantPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const utils = trpc.useUtils();
  const status = trpc.ai.status.useQuery();
  const conversations = trpc.ai.conversations.useQuery(undefined, {
    enabled: status.data?.configured === true,
  });
  const create = trpc.ai.createConversation.useMutation({
    onSuccess: async (c) => {
      await utils.ai.conversations.invalidate();
      navigate(`/assistant/${c.id}`);
    },
    onError: toast.error,
  });
  const remove = trpc.ai.deleteConversation.useMutation({
    onSuccess: async () => {
      await utils.ai.conversations.invalidate();
      navigate("/assistant");
    },
    onError: toast.error,
  });

  return (
    <>
      <PageHeader
        eyebrow="Assist"
        title="Assistant"
        lede="Ask questions about live operational data. It sees only what you can see, and every change waits for your confirmation."
        actions={
          status.data?.configured ? (
            <Button variant="primary" loading={create.isPending} onClick={() => create.mutate({})}>
              <MessageSquarePlus aria-hidden /> New conversation
            </Button>
          ) : null
        }
      />
      {status.isLoading ? <SkeletonRows rows={3} /> : null}
      {status.data && !status.data.configured ? (
        <div className="panel">
          <EmptyState icon={<Sparkles size={18} />} title="The AI assistant is not configured on this server">
            An administrator needs to set <span className="mono">ANTHROPIC_API_KEY</span> in the server
            environment. Everything else in FLOWOS works without it; the command center briefing is rule-based
            and does not use AI.
          </EmptyState>
        </div>
      ) : null}
      {status.data?.configured ? (
        <div className="grid assistant-layout">
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
                      onClick={() => remove.mutate({ id: c.id })}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
          {id ? (
            <Transcript key={id} id={id} />
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
                Try “What needs my attention today?”
              </EmptyState>
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}
