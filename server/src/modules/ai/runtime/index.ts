import { AnthropicRuntime } from "./anthropic";
import { OpenAiCompatibleRuntime } from "./openai-compatible";
import type { ModelRuntime } from "./types";

export * from "./types";

export const MODEL_PROVIDERS = ["none", "openai-compatible", "anthropic"] as const;

export interface RuntimeSelection {
  runtime: ModelRuntime | null;
  /** Why no runtime is active although one was requested (variable names only, never values). */
  configError: string | null;
}

/**
 * Pick the inference runtime from configuration. The choice is explicit and
 * fixed for the process: there is no fallback from one provider to another.
 *
 *   FLOWOS_MODEL_PROVIDER = none | openai-compatible | anthropic
 *   FLOWOS_MODEL_URL, FLOWOS_MODEL_NAME  (openai-compatible; e.g. http://localhost:8080/v1)
 *   FLOWOS_MODEL_API_KEY                 (optional, for a self-hosted gateway)
 *   ANTHROPIC_API_KEY                    (anthropic)
 *
 * Without FLOWOS_MODEL_PROVIDER: a model URL selects openai-compatible; otherwise an
 * ANTHROPIC_API_KEY selects anthropic (existing deployments); otherwise none.
 */
export function selectRuntime(source: NodeJS.ProcessEnv = process.env): RuntimeSelection {
  const requested = source.FLOWOS_MODEL_PROVIDER?.trim().toLowerCase() || null;
  const provider =
    requested ??
    (source.FLOWOS_MODEL_URL ? "openai-compatible" : source.ANTHROPIC_API_KEY ? "anthropic" : "none");
  const int = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  switch (provider) {
    case "none":
      return { runtime: null, configError: null };
    case "openai-compatible": {
      const url = source.FLOWOS_MODEL_URL?.trim();
      const name = source.FLOWOS_MODEL_NAME?.trim();
      if (!url || !name)
        return {
          runtime: null,
          configError: "FLOWOS_MODEL_URL and FLOWOS_MODEL_NAME are required for openai-compatible.",
        };
      try {
        const parsed = new URL(url);
        if (!/^https?:$/.test(parsed.protocol)) throw new Error("protocol");
        if (parsed.username || parsed.password) throw new Error("credentials");
      } catch {
        return {
          runtime: null,
          configError: "FLOWOS_MODEL_URL must be an http(s) URL without credentials in it.",
        };
      }
      return {
        runtime: new OpenAiCompatibleRuntime({
          baseUrl: url,
          model: name,
          apiKey: source.FLOWOS_MODEL_API_KEY || undefined,
          timeoutMs: int(source.FLOWOS_MODEL_TIMEOUT_MS, 120_000),
          maxTokens: int(source.FLOWOS_MODEL_MAX_TOKENS, 1024),
        }),
        configError: null,
      };
    }
    case "anthropic":
      return source.ANTHROPIC_API_KEY
        ? { runtime: new AnthropicRuntime(source.ANTHROPIC_API_KEY), configError: null }
        : { runtime: null, configError: "ANTHROPIC_API_KEY is required for the anthropic provider." };
    default:
      return {
        runtime: null,
        configError: `FLOWOS_MODEL_PROVIDER must be one of ${MODEL_PROVIDERS.join(", ")}.`,
      };
  }
}

let selection: RuntimeSelection | undefined;

export function getRuntimeSelection(): RuntimeSelection {
  selection ??= selectRuntime();
  return selection;
}

/** The configured runtime, or null: the engine then works in rules mode. */
export function getModelRuntime(): ModelRuntime | null {
  return getRuntimeSelection().runtime;
}

/** Test hook: inject a runtime (or null for rules mode). */
export function setModelRuntime(runtime: ModelRuntime | null) {
  selection = { runtime, configError: null };
}
