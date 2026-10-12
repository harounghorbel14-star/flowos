# FLOWOS Intelligence Engine

The assistant is a FLOWOS-owned engine: FLOWOS plans each request as explicit
steps over typed tools, enforces policy, executes, verifies, remembers and
reports. A language model is optional. When one is configured it runs on
infrastructure you choose (self-hosted by default) and only proposes plans and
wording; FLOWOS decides what runs.

This is not an independently trained model, and it is not fully autonomous.
Rules mode is a deterministic planner for a fixed set of commands; it does not
understand arbitrary language.

## 1. Architecture

### Before (`main` at 7dc1472)

| Part                           | Where                          | Owned by FLOWOS?                                                                        |
| ------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------- |
| Model access                   | `ai/provider.ts`               | No. Anthropic SDK only; its message types ran through every layer                       |
| Turn loop                      | `ai/assistant.ts`              | The loop and limits, yes; all reasoning and planning were delegated to the hosted model |
| Tool registry                  | `ai/tools.ts`                  | Yes: 11 typed tools over the real services, permission-filtered                         |
| Confirmation flow              | `assistant.ts` `confirmAction` | Yes: input hash, expiry, single use, re-authorization, audit                            |
| Transcript                     | `ai_messages`                  | Stored in the provider's block format                                                   |
| Without `ANTHROPIC_API_KEY`    |                                | The assistant answered nothing ("not configured")                                       |
| Planning, memory, verification |                                | None                                                                                    |

### After

```
              ┌──────────────────── IntelligenceEngine (engine.ts) ────────────────────┐
 message  →   │ IntentRouter ─► Planner ─► PolicyEngine ─► TaskExecutor ─► Report     │ → NDJSON events
              │ (intents.ts)   (planner.ts) (policy.ts)    (executor.ts)  (runs.ts)    │
              │      │             ▲                            │                      │
              │ ContextEngine ─────┘     ModelRuntime      ResultEvaluator (verify)    │
              │ (memory.ts, analysis.ts) (runtime/*)       RecoveryManager (retries)   │
              └────────────── ai_runs · ai_run_steps · ai_memories · ai_actions ───────┘
```

| Module                           | Responsibility                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runtime/`                       | Provider-neutral messages, tools and errors; adapters `openai-compatible` (self-hosted) and `anthropic` (optional, hosted). Explicit selection, no fallback. |
| `intents.ts`                     | Rules-mode intent router for the supported commands; answer composition from real results.                                                                   |
| `planner.ts`                     | Explicit plans per intent; steps whose input depends on earlier results; re-planning after observation (e.g. one follow-up per blocked task).                |
| `analysis.ts`                    | FLOWOS-owned analyses: prioritization, overdue ranking, blocked-work detection, resolution steps. Documented rules, evidence, stated gaps.                   |
| `policy.ts`                      | The single place that decides run / auto / confirm / deny, plus all limits.                                                                                  |
| `executor.ts`                    | Validates, times out, retries transient read failures, prepares confirmations (with precondition snapshots), runs low-risk writes and verifies them.         |
| `engine.ts`                      | Orchestration of both modes, model plan validation (`submit_plan`), loop prevention, grounding check, cancellation, time budget.                             |
| `runs.ts`                        | Persisted runs and steps; status derived only from step results; reports and deterministic run summaries.                                                    |
| `memory.ts`                      | Scoped memory with retention and deletion; labelled context for a model.                                                                                     |
| `assistant.ts`                   | Conversations, confirmation (precondition check → execute → verify → remember), rejection, status.                                                           |
| `client/src/pages/Assistant.tsx` | Run cards (mode, objective, plan, live step status, results, verification, notes, evidence), confirmations, runtime banner, memory panel.                    |

## 2. External AI dependencies

| Dependency                          | Status                                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Anthropic API (`@anthropic-ai/sdk`) | **Retained as an optional adapter.** No longer required by anything. Used only when an operator selects it (or sets only `ANTHROPIC_API_KEY`, for existing deployments). Never a fallback. |
| Any hosted LLM API                  | **Not required** to start the app, to use FLOWOS, or to use the assistant in rules mode.                                                                                                   |
| Self-hosted model                   | **Optional**, through any OpenAI-compatible server (llama.cpp `llama-server --jinja`, Ollama, vLLM, LM Studio, LocalAI). Plain `fetch`; no new npm dependency.                             |
| Bundled model                       | None. No model is shipped in the web app or the container image.                                                                                                                           |

## 3. What works without any model

Planned and executed by FLOWOS rules, from live records, with the user's permissions:

| Command (examples)                                                        | What FLOWOS does                                                                                                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| What needs my attention?                                                  | Operational snapshot + rule-based briefing                                                                                                       |
| What should I prioritize today?                                           | Ranks the user's open tasks, approvals awaiting them and projects they own at risk; shows the rules                                              |
| What are the most urgent overdue tasks? / my overdue tasks                | Ranks overdue tasks: priority × 10 + days late (max 60), +5 unassigned                                                                           |
| Which projects are blocked?                                               | Projects with tasks marked Blocked or On hold (plus overdue/past-due signals), with the blocked tasks; states that FLOWOS has no dependency data |
| Which approvals are waiting for me?                                       | Inbox of pending requests                                                                                                                        |
| Show my tasks · Show weekly trends                                        | Lists / measured trends                                                                                                                          |
| How can we unblock <project>?                                             | Finds the project (skips if ambiguous), applies resolution rules to its tasks, cites each record                                                 |
| Create follow-up tasks for blocked tasks [in <project>]                   | Multi-step: finds blocked tasks, then adds one prepared follow-up per task (max 5), same owner and project                                       |
| Create task <title> [due …] [for <person>] [in project <name>] [priority] | Resolves person and project (skips with the reason when 0 or several match), prepares the task                                                   |
| Mark #12 as done (in progress, blocked, review, to do)                    | Finds the task, skips if already in that state, prepares the change                                                                              |
| Mark my notifications as read                                             | Low-risk, own data: executed automatically, verified, audited                                                                                    |
| Remember <preference>                                                     | Saved verbatim as a preference (never passes through a model)                                                                                    |

Anything else gets an honest "I can't interpret that request … I won't guess"
with the list above.

## 4. What needs a model

Free-form questions and phrasing outside those commands, multi-step reasoning
across tools that no rule covers, and natural-language synthesis. With
`FLOWOS_ASSISTANT_ROUTING=rules-first` (default) supported commands still go
to FLOWOS rules; with `model-first` the model plans everything except memory
commands. In model mode the model must declare a plan (`submit_plan`); FLOWOS
validates each step against the user's tools and the policy, executes the
calls, records steps (planned or added while adapting), and writes the
report. An answer that used no FLOWOS record is labelled
**Unverified answer**.

## 5. Planning and execution

1. **Objective**: rules mode names it from the intent; a model states it in `submit_plan`.
2. **Context**: records via services as the user; labelled memory (`[Memory]`) and action outcomes for a model.
3. **Plan**: explicit steps (`ai_run_steps`), shown before execution.
4. **Validation**: every step through `policy.decide` (permissions, risk, limits); a model's unknown or forbidden steps are rejected and reported back.
5. **Approval**: standard-risk writes become prepared actions bound to the input hash and a precondition snapshot.
6. **Execution**: in order, 15 s timeout per step, 120 s per run, at most 12 steps, 5 writes, 8 model requests.
7. **Observation**: each result is stored with a one-line summary; dependent inputs are computed from it.
8. **Re-planning**: rules plans expand after observation; a model may resubmit its plan (unstarted steps are superseded, not failed). Failed or unresolvable steps are skipped with the reason.
9. **Verification**: after a write, records are re-read (`verify`); only matching changes are marked verified and remembered.
10. **Report**: status (Completed, Partly completed, Waiting for confirmation, Failed, Stopped) and per-step outcomes, derived from the stored steps only.

Recovery: reads that fail for transient reasons (deadlock, serialization,
connection, timeout) are retried up to 2 more times with backoff; domain errors
and writes are never retried. The same call with the same input is refused
the third time in a run. Stop cancels steps that have not run. An unreachable
model is reported as such (distinct from a tool failure or a bad answer); the
request is then answered by FLOWOS rules when it is a supported command.

## 6. Safety boundaries

- **Reads** run; **low-risk** writes limited to the user's own data run automatically and are audited (today: mark own notifications read; save own preference).
- **Standard** writes (create task, change task status) only run when the user confirms the exact prepared input, within 10 minutes, once, with permissions re-checked, and only if the target still matches its snapshot.
- **Never available to the agent** (no tool exists): deleting records; roles, memberships, permissions; deciding approvals; billing, plan, org settings; external messages; workflows.
- The agent acts as the user and cannot gain permissions: policy and services check the user's current role on every step and at confirmation.
- No arbitrary code, SQL, shell or network: only registered, typed tools over FLOWOS services.

## 7. Memory

| Scope             | Written by                                                 | Visible to                     | Retention               |
| ----------------- | ---------------------------------------------------------- | ------------------------------ | ----------------------- |
| Preferences       | the user ("remember …" or the Memory panel)                | that user                      | until deleted           |
| Org knowledge     | people with `org:update` (audited)                         | everyone with the assistant    | until deleted           |
| Verified outcomes | the engine, only after re-reading a change (DB constraint) | that user                      | 90 days (purged hourly) |
| Previous requests | deterministic run summaries (never model text)             | that user, other conversations | with the conversation   |

No vector database: the existing typed search and analyses cover the
structured data; document contents are not indexed (see limitations).

## 8. Model runtime and hosting

```
FLOWOS_MODEL_URL=http://llm-host:8080/v1     FLOWOS_MODEL_NAME=qwen2.5-7b-instruct
FLOWOS_ASSISTANT_ROUTING=rules-first         # default
```

**Sizing guidance** (typical figures for llama.cpp/Ollama, not measured here):

| Model (GGUF Q4_K_M)                | Weights    | RAM/VRAM incl. 16k context | CPU only (8 modern cores)            | GPU (8 GB+)      |
| ---------------------------------- | ---------- | -------------------------- | ------------------------------------ | ---------------- |
| Qwen2.5-7B / Llama-3.1-8B Instruct | 4.4–4.9 GB | 7–8 GB                     | ~5–10 tokens/s; a tool turn ~30–90 s | ~40–100 tokens/s |
| Qwen2.5-3B Instruct                | ~2 GB      | 3–4 GB                     | ~15–25 tokens/s                      | fast             |

Run the model on its own host or container (not inside the FLOWOS web
process); Render Free cannot host it. A GPU is recommended for interactive use.

### Local model trial (measured in this environment)

- **Runtime**: llama.cpp `llama-server` (built from source at `8bb3cf0`), `--jinja`, 4 vCPU, no GPU.
- **Model**: TinyLlama 1.1B Chat, IQ2_XXS (322 MB GGUF), the only model weights reachable from this sandbox. Hugging Face and Ollama were blocked by its network policy. The weights were checked against the publisher's SHA-256.
- **Wiring verified for real**: FLOWOS selected the runtime and streamed tokens through the adapter. It recorded usage (495–624 prompt tokens, 1024 output tokens, 86–88 s per request, ~25 tokens/s generation). The run, report, grounding label and UI worked. The reachability check showed the server as down, and stopping the server produced a "model unavailable" run followed by a rules answer, with no other provider tried.
- **Quality: failed, as expected.** llama.cpp does not inject tool definitions for this model's chat template: the prompt is 24 tokens with or without tools. The model therefore never called a tool and produced repetitive, ungrounded text. FLOWOS labelled it "Unverified answer". `npm run test:live` against it: **1 of 4 passed** (the viewer is never offered write tools). Three failed because no tool was called.
- **Conclusion**: the self-hosted path works end to end. Useful model-mode answers need a tool-capable model such as Qwen2.5-7B-Instruct, which was not available here. With rules-first routing, supported commands were answered correctly in ~25 ms regardless of the model.

## 9. Tests

| Suite                                                   | Result                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check` (format, lint, typecheck, tests, build) | pass; **234 tests / 25 files** (35 new for the engine; 15 ported to the neutral runtime)                                                                                                                                                                                                    |
| `ai-engine.test.ts` (24)                                | rules mode, multi-step + dependencies, skip-not-guess, re-planning, precondition voiding, role enforcement, auto low-risk action, Stop, retries, timeout, loop prevention, request limit, plan validation, grounding label, model unavailable, routing, memory isolation/deletion/retention |
| `ai.test.ts` (15) · `ai-http.test.ts` (1)               | model mode via a scripted runtime: permissions, confirmation, verification, cross-tenant, refusals, truncation, locks, cancellation; NDJSON endpoint incl. rules mode                                                                                                                       |
| `ai-runtime.test.ts` (11)                               | intent router, date parsing, policy table, runtime selection, OpenAI-compatible adapter against a local fake server (streaming, split tool calls, errors, timeout), legacy transcripts                                                                                                      |
| Browser smoke (`npm run test:e2e`)                      | **36 / 36**, 0 console problems (new step: rules-mode assistant, confirm + verify, memory, unsupported request)                                                                                                                                                                             |
| Browser assistant, model mode (`test:e2e:assistant`)    | **6 / 6** with the scripted runtime                                                                                                                                                                                                                                                         |
| `npm run test:live`                                     | TinyLlama (local): 1 / 4, see above. Not run against Anthropic (no paid calls).                                                                                                                                                                                                             |

Bundle: JS +8.1 kB raw (+2.3 kB gzip), CSS +2.0 kB raw, versus `main`.

## 10. Limitations and remaining work

- **Model quality is unproven** in this environment. Validate a tool-capable model (e.g. Qwen2.5-7B-Instruct) on your hardware with `npm run test:live` before relying on model mode.
- Rules mode understands only the listed phrasings; parsing is literal (e.g. "for the offsite" is read as an assignee, then reported as unresolvable).
- Analyses use what FLOWOS records: no task dependencies, no document contents (no retrieval over files), no calendars.
- Writes cover tasks only (create, status) plus own notifications; more write tools need their own preconditions and verification.
- Policy is code-level; there are no per-organization autonomy settings or AI budgets beyond the plan quota.
- No admin dashboard for run traces yet (data is in `ai_runs` / `ai_run_steps` / `ai_usage`).
- Model mode with rules-first routing still sends free-form requests to the model even when they touch data FLOWOS could answer.
