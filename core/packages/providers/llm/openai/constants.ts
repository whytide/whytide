// The OpenAI adapter's constants (README.md "Models", "Known differences"): the API, the models it
// serves with the reasoning efforts each takes, and what every call sets. The models and their
// prices were checked against OpenAI's model pages on 2026-11-02; the prices themselves live in
// COST_PRICES_JSON (the README has the lines).

/** OpenAI's API, set in code: the SDK never reads OPENAI_BASE_URL. */
export const OPENAI_API = "https://api.openai.com/v1";
/** The day the models were checked against OpenAI's pages; informational (llm/README.md). */
export const PRICE_LIST = "openai-2026-11-02";

/** The reasoning efforts LLM_OPENAI_REASONING_EFFORT takes, least first. */
export const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
/** The owner's choice, 2026-11-02. */
export const DEFAULT_EFFORT: Effort = "medium";
/** The model listed first unless LLM_MODEL_DEFAULT names another: OpenAI's balanced model. */
export const DEFAULT_MODEL = "gpt-6.1-sol";

const ALL: readonly Effort[] = EFFORTS;
const REASONING: readonly Effort[] = EFFORTS.filter((effort) => effort !== "none");
/**
 * The models served, in the order listed after the default, each with the efforts @ai-sdk/openai
 * 4.0.93 sends for it (its getOpenAILanguageModelCapabilities). The SDK drops an effort off that
 * list, and the model would then reason at the API's default, medium, so the adapter serves a model
 * only at an effort the list holds. The price is per 1M tokens, input/output.
 */
export const MODELS: Readonly<Record<string, readonly Effort[]>> = {
  /** The balanced model, $2/$10: low to max at the API too. */
  "gpt-6.1-sol": REASONING,
  /** The flagship, $10/$50: low to max. */
  "gpt-6-astra": REASONING,
  /** The fast model, $1/$5: none to max at the API, but the SDK predates it and drops none. */
  "gpt-6.1-terra": REASONING,
  /** The cheapest, $0.10/$0.50: none to max. */
  "gpt-6-luna": ALL,
  /** The older Sol, $2/$10: none to max. */
  "gpt-6-sol": ALL,
};

/**
 * Added to a call's maxOutputTokens when the model reasons, since reasoning tokens count inside
 * max_output_tokens: OpenAI's guidance for reasoning plus output, so a task's budget stays its
 * answer's room. Only the tokens used are billed.
 */
export const REASONING_HEADROOM = 25_000;

/**
 * Set on every call below bindModel, which refuses the caller's own (README.md "Known
 * differences"): OpenAI keeps no response for retrieval, no reasoning summary is asked for (the app
 * never reads one), and an output schema is sent strict, in strict mode's subset (STRICT_KEYWORDS).
 */
export const CALL_OPTIONS = {
  store: false,
  reasoningSummary: null,
  strictJsonSchema: true,
} as const;

/**
 * The JSON Schema keywords OpenAI's strict mode supports, from its Structured Outputs guide,
 * "Supported schemas" (read 2026-11-02): with strict on, any other fails the call, so a response
 * schema goes out with these alone (schema.ts). `definitions` is draft-07's `$defs`. minLength,
 * maxLength, `$schema`, title and default are among those dropped; zod still checks every answer
 * against the whole schema.
 */
export const STRICT_KEYWORDS: ReadonlySet<string> = new Set([
  ...["type", "properties", "required", "additionalProperties", "items", "anyOf", "enum", "const"],
  ...["description", "$ref", "$defs", "definitions"],
  ...["pattern", "format"],
  ...["multipleOf", "maximum", "exclusiveMaximum", "minimum", "exclusiveMinimum"],
  ...["minItems", "maxItems"],
]);
/** The `format` values strict mode supports; another, `uri` from z.url() say, is dropped. */
export const STRICT_FORMATS: ReadonlySet<string> = new Set([
  ...["date-time", "time", "date", "duration"],
  ...["email", "hostname", "ipv4", "ipv6", "uuid"],
]);

/**
 * The provider id the adapter's model reports, which telemetry and Mastra read. Never one that
 * starts with "openai": Mastra then adds `providerOptions.openai.strictJsonSchema` to every
 * structured call, which bindModel refuses, as it refuses every caller's provider option;
 * CALL_OPTIONS sets it instead.
 */
export const PROVIDER_ID = "whytide-openai.responses";

/** OpenAI's error code for an account out of credits: a 429 that no wait cures. */
export const INSUFFICIENT_QUOTA = "insufficient_quota";
