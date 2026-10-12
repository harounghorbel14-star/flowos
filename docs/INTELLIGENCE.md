# FLOWOS Intelligence Engine

## Before (audit of `main` at 7dc1472)

| Part                             | Where                               | Owned by FLOWOS?                                                                                                   |
| -------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Model access                     | `modules/ai/provider.ts`            | No. The only implementation is the Anthropic SDK. Types (`BetaMessageParam`, `BetaTool`) leak into every layer.    |
| Turn loop (reason → tool → loop) | `modules/ai/assistant.ts` `runTurn` | Loop and limits yes; all reasoning and planning delegated to the hosted model.                                     |
| Tool registry                    | `modules/ai/tools.ts`               | Yes: 11 typed (Zod) tools over the real services, permission-filtered.                                             |
| Confirmation flow                | `assistant.ts` `confirmAction`      | Yes: input hash, expiry, single use, re-authorization, audit.                                                      |
| Transcript                       | `ai_messages` (append-only)         | Stored in Anthropic's content-block format.                                                                        |
| Observability                    | `ai_tool_calls`, `ai_usage`         | Yes (per tool call and per model request).                                                                         |
| Without `ANTHROPIC_API_KEY`      |                                     | The app runs; the assistant answers nothing ("not configured"). The command-center briefing is already rule-based. |
| Planning, memory, verification   |                                     | None: no explicit plan, no memory beyond the transcript, no check that a write did what was intended.              |

## After

```
            ┌───────────────── IntelligenceEngine (engine.ts) ─────────────────┐
 message →  │ IntentRouter ─► Planner ─► PolicyEngine ─► TaskExecutor ─► Report │ → NDJSON events
            │      │             ▲            │               │                │
            │ ContextEngine ─────┘      ModelRuntime      ResultEvaluator      │
            │ (records, memory)        (optional)         RecoveryManager      │
            └───────────── ai_runs / ai_run_steps / ai_memories ───────────────┘
```

- **ModelRuntime** (`runtime/`): provider-neutral messages and tools. Adapters:
  `openai-compatible` (any self-hosted server: llama.cpp `llama-server`, Ollama,
  vLLM, LM Studio, LocalAI), `anthropic` (optional, explicit), or none. Selected
  explicitly by configuration; never falls over from one to another.
- **Rules mode** (no model): an intent router for explicitly supported commands,
  deterministic planners, and FLOWOS-owned analyses (prioritization, overdue
  ranking, blocked-work and deadline analysis, resolution steps). Everything
  else is answered honestly with what is supported.
- **Model mode**: the model plans (`submit_plan`), calls the same typed tools
  (including the deterministic analyses), observes results and re-plans. The
  engine — not the model — records each step and writes the final report.
- **Runs and steps** are persisted, so every answer shows its objective, plan,
  step status, results, confirmations, failures and verified outcomes.
- **PolicyEngine** centralizes risk: reads run; low-risk own-data writes run
  automatically; standard writes need confirmation bound to the exact input and
  to a precondition snapshot; high-impact operations are not available to the agent.
- **ResultEvaluator** re-reads records after a write; **RecoveryManager**
  retries only transient read failures, with bounded attempts and backoff.
- **MemoryManager**: user preferences and organization knowledge (written only
  by people), verified outcomes (written only by the engine after verification),
  and summaries of previous runs. Tenant- and user-scoped, listable, deletable,
  with retention.

Sections below are completed with results at the end of the work.
