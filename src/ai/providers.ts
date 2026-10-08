import type { Summarizer } from "./summarize.js";
import type { Synthesizer } from "./synthesize.js";
import type { CruxSummarizer } from "./crux.js";
import type { ChatModel } from "./llm/types.js";
import type { ProviderKind } from "./llm/factory.js";

/**
 * User-facing configuration. Anything omitted falls back to environment
 * variables and then to sensible defaults.
 *
 * symgraph is vendor-neutral: `provider` names only the WIRE FORMAT, not a company.
 * `openai` speaks the OpenAI-compatible API — point `baseUrl` at OpenRouter,
 * Fireworks, a LiteLLM proxy, Groq, a local server, or OpenAI itself, and pass
 * your own key. `anthropic` speaks the native Messages API. Any LLM-backed
 * operation needs an API key.
 */
export interface EngineConfig {
  /** Where the graph lives. Env: SYMGRAPH_DIR. Default: `<repo>/.context`. */
  contextDir?: string;

  /** Wire format / SDK. Env: SYMGRAPH_PROVIDER. Default: `openai`. */
  provider?: ProviderKind;
  /** API key for the chosen provider. Env: SYMGRAPH_API_KEY (legacy: OPENROUTER_API_KEY;
   * for `anthropic` also ANTHROPIC_API_KEY). */
  apiKey?: string;
  /** Model id. Env: SYMGRAPH_MODEL. Provider-specific default. */
  model?: string;
  /** Base URL for OpenAI-compatible endpoints. Env: SYMGRAPH_BASE_URL. */
  baseUrl?: string;

  // --- advanced: bring your own components ---
  /** Override the whole transport (skips provider/apiKey/baseUrl). */
  chatModel?: ChatModel;
  /** Override the synthesizer. */
  synthesizer?: Synthesizer;
  /** Override the code summarizer. */
  summarizer?: Summarizer;
  /** Override the per-symbol crux summarizer. */
  cruxSummarizer?: CruxSummarizer;
}

/** Fully-resolved configuration with all defaults applied. */
export interface ResolvedConfig {
  contextDir?: string;
  provider: ProviderKind;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  /** True when the key came from the deprecated OPENROUTER_* fallback. */
  usedLegacyEnv: boolean;
  chatModel?: ChatModel;
  synthesizer?: Synthesizer;
  summarizer?: Summarizer;
  cruxSummarizer?: CruxSummarizer;
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const ORCAROUTER_BASE_URL = "https://api.orcarouter.ai/v1";

/** Per-provider default model. */
export const DEFAULT_MODELS: Record<ProviderKind, string> = {
  openai: "openai/gpt-4o-mini",
  // The cheap tier: `--deep` is many short, structured calls, not hard reasoning.
  anthropic: "claude-haiku-5-5",
  // Provider-prefixed so the LiteLLM proxy routes it; override with SYMGRAPH_MODEL.
  litellm: "openai/gpt-4o-mini",
  // Provider-prefixed so the OrcaRouter gateway routes it; override with SYMGRAPH_MODEL.
  orcarouter: "openai/gpt-4o-mini",
};

export const DEFAULTS = {
  provider: "openai" as ProviderKind,
  model: DEFAULT_MODELS.openai,
} as const;

/** Merge user config with environment variables and defaults. */
export function resolveConfig(config: EngineConfig = {}): ResolvedConfig {
  const env = process.env;
  const provider = config.provider ?? (env.SYMGRAPH_PROVIDER as ProviderKind | undefined) ?? DEFAULTS.provider;

  const explicitKey = config.apiKey ?? env.SYMGRAPH_API_KEY;
  const legacyKey = env.OPENROUTER_API_KEY;
  // The native provider also takes the key the Anthropic SDK itself reads.
  const vendorKey = provider === "anthropic" ? env.ANTHROPIC_API_KEY : undefined;
  const apiKey = explicitKey ?? legacyKey ?? vendorKey ?? env.ORCAROUTER_API_KEY;
  const usedLegacyEnv = !explicitKey && !!legacyKey;

  const model =
    config.model ??
    env.SYMGRAPH_MODEL ??
    env.SYMGRAPH_OPENROUTER_MODEL ??
    env.ORCAROUTER_MODEL ??
    DEFAULT_MODELS[provider];

  let baseUrl = config.baseUrl ?? env.SYMGRAPH_BASE_URL ?? env.OPENROUTER_BASE_URL ?? env.ORCAROUTER_BASE_URL;
  // Back-compat: an existing setup with only OPENROUTER_API_KEY keeps hitting
  // OpenRouter without any config change.
  if (!baseUrl && provider === "openai" && usedLegacyEnv) baseUrl = OPENROUTER_BASE_URL;
  // The orcarouter provider points at the gateway unless a base URL is given.
  if (!baseUrl && provider === "orcarouter") baseUrl = ORCAROUTER_BASE_URL;

  const headers =
    provider === "openai" && baseUrl?.includes("openrouter.ai")
      ? { "X-Title": "symgraph" }
      : undefined;

  return {
    contextDir: config.contextDir ?? env.SYMGRAPH_DIR,
    provider,
    apiKey,
    model,
    baseUrl,
    headers,
    usedLegacyEnv,
    chatModel: config.chatModel,
    synthesizer: config.synthesizer,
    summarizer: config.summarizer,
    cruxSummarizer: config.cruxSummarizer,
  };
}
