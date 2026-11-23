// The OpenAI adapter of the LLM port (README.md): OpenAI's models on its Responses API, through the
// AI SDK's provider, @ai-sdk/openai, imported in this folder only (tools/lint/vendor-sdks.json).
// The key, the default model and the reasoning effort come from config and are checked when the
// adapter starts; the effort decides the models served. The base URL is passed in code, so the SDK
// never reads OPENAI_BASE_URL or OPENAI_API_KEY, and it sends no organization or project; a test
// passes a local one. Each model sets the adapter's own options on every call, keeps a response
// schema to strict mode's subset (schema.ts) and maps the vendor's failures it knows to the port's
// codes, then goes out through bindModel(), the boundary of every model call (llm/boundary.ts),
// which refuses the caller's own options and wraps the rest.
import { createOpenAI } from "@ai-sdk/openai";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { AppError, platformConfig } from "@whytide/platform";
import { wrapLanguageModel } from "ai";
import { defineAdapter, type PortImplementation } from "../../_pattern/index.ts";
import { bindModel } from "../boundary.ts";
import { llmPort } from "../port.ts";
import { openaiConfig } from "./config.ts";
import {
  CALL_OPTIONS,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EFFORTS,
  type Effort,
  INSUFFICIENT_QUOTA,
  MODELS,
  OPENAI_API,
  PRICE_LIST,
  PROVIDER_ID,
  REASONING_HEADROOM,
} from "./constants.ts";
import { strictSubset } from "./schema.ts";

const BY_STATUS = new Map<unknown, keyof typeof llmPort.errors>([
  [401, "llm_invalid_key"],
  [429, "llm_rate_limited"],
]);

export type OpenAIOptions = {
  readonly apiKey: string;
  /** OpenAI's API, unless a test names a local stand-in; never from the environment. */
  readonly baseURL?: string;
  /** The model listed first, when it is served at the effort; DEFAULT_MODEL by default. */
  readonly defaultModel?: string;
  /** Every call's reasoning effort; DEFAULT_EFFORT by default. */
  readonly effort?: Effort;
  /** Keep the vendor error as the cause; by default outside production, as bindModel does. */
  readonly keepCause?: boolean;
};

const isEffort = (value: string): value is Effort => (EFFORTS as readonly string[]).includes(value);

/** The models served at `effort`, `defaultModel` first when it is one of them. */
function modelsAt(effort: Effort, defaultModel?: string): string[] {
  const served = Object.keys(MODELS).filter((modelId) => MODELS[modelId]?.includes(effort));
  return defaultModel !== undefined && served.includes(defaultModel)
    ? [defaultModel, ...served.filter((modelId) => modelId !== defaultModel)]
    : served;
}

type ErrorBody = {
  readonly code?: unknown;
  readonly error?: { readonly code?: unknown } | null;
  readonly response?: { readonly error?: { readonly code?: unknown } | null } | null;
};

/**
 * OpenAI's insufficient_quota, wherever the SDK puts its code: a response's JSON error
 * (`{ error: { code } }`) or a stream's error frame before any output (`{ code }`, or a failed
 * response's `{ response: { error: { code } } }`), both as the error's `data`; or an error part's
 * own.
 */
function outOfCredits(error: unknown): boolean {
  const { code, data } = (error ?? {}) as { code?: unknown; data?: ErrorBody | null };
  const codes = [code, data?.code, data?.error?.code, data?.response?.error?.code];
  return codes.includes(INSUFFICIENT_QUOTA);
}

/** A 429's wait in whole seconds: from retry-after-ms, else retry-after, in seconds or a date. */
function retryAfterSec(error: unknown, now = Date.now()): number | undefined {
  const headers = (error as { responseHeaders?: Record<string, string> } | null)?.responseHeaders;
  const ms = Number(headers?.["retry-after-ms"]);
  const after = headers?.["retry-after"]?.trim() ?? "";
  const seconds =
    ms > 0
      ? ms / 1000
      : /^\d+(\.\d+)?$/.test(after)
        ? Number(after)
        : (Date.parse(after) - now) / 1000;
  return seconds > 0 ? Math.ceil(seconds) : undefined;
}

/**
 * A vendor failure this adapter knows, as the port's code: a timeout or an abort, 401, 429 with the
 * wait it asks for, insufficient_quota (a 429 as well, but the account is out of credits, so it is
 * llm_provider_error, never retried as a rate limit) and 5xx, thrown or sent as a stream's error
 * part. Details hold the status and that one code word, never the message. Anything else goes on as
 * it is, for bindModel to wrap unmapped.
 */
function portError(error: unknown, signal: AbortSignal | undefined, keepCause: boolean): unknown {
  const { name, statusCode } = (error ?? {}) as { name?: unknown; statusCode?: unknown };
  // The SDK passes a timeout or an abort on as the signal's reason, an Error or not.
  if (signal?.aborted || name === "AbortError" || name === "TimeoutError") {
    return new AppError(llmPort.errors.llm_timeout);
  }
  const cause = keepCause ? error : undefined;
  if (outOfCredits(error)) {
    const details = { method: "model", code: INSUFFICIENT_QUOTA, status: statusCode };
    return new AppError(llmPort.errors.llm_provider_error, { details, cause });
  }
  const code =
    BY_STATUS.get(statusCode) ??
    (typeof statusCode === "number" && statusCode >= 500 ? "llm_provider_error" : undefined);
  if (code === undefined) return error;
  const wait = code === "llm_rate_limited" ? retryAfterSec(error) : undefined;
  const details = { method: "model", code: statusCode, ...(wait ? { retryAfterSec: wait } : {}) };
  return new AppError(llmPort.errors[code], { details, cause });
}

async function mapping<T>(step: () => PromiseLike<T>, fail: (error: unknown) => unknown) {
  try {
    return await step();
  } catch (error) {
    throw fail(error);
  }
}

/** A JSON response format with its schema in strict mode's subset, as a copy; another as it is. */
function strictFormat(format: LanguageModelV4CallOptions["responseFormat"]) {
  return format?.type === "json" && format.schema !== undefined
    ? { ...format, schema: strictSubset(format.schema) }
    : format;
}

/**
 * The vendor's model as every call reaches it: the adapter's own options set, the response schema
 * in strict mode's subset, its failures mapped, under a provider id of its own (PROVIDER_ID).
 */
function ours(model: LanguageModelV4, effort: Effort, keepCause: boolean): LanguageModelV4 {
  return wrapLanguageModel({
    model,
    providerId: PROVIDER_ID,
    middleware: {
      specificationVersion: "v4",
      // bindModel, above, refused the caller's provider options: these are the adapter's own.
      transformParams: async ({ params }) => ({
        ...params,
        providerOptions: { openai: { ...CALL_OPTIONS, reasoningEffort: effort } },
        maxOutputTokens:
          params.maxOutputTokens === undefined || effort === "none"
            ? params.maxOutputTokens
            : params.maxOutputTokens + REASONING_HEADROOM,
        responseFormat: strictFormat(params.responseFormat),
      }),
      wrapGenerate: ({ doGenerate, params }) =>
        mapping(doGenerate, (error) => portError(error, params.abortSignal, keepCause)),
      wrapStream: async ({ doStream, params }) => {
        const fail = (error: unknown) => portError(error, params.abortSignal, keepCause);
        const { stream, ...rest } = await mapping(doStream, fail);
        const parts = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform: (part, controller) =>
            controller.enqueue(part.type === "error" ? { ...part, error: fail(part.error) } : part),
        });
        return { ...rest, stream: stream.pipeThrough(parts) };
      },
    },
  });
}

/** The adapter's implementation for a key; a test passes a local base URL, an effort, keepCause. */
export function openaiLlm({
  apiKey,
  baseURL = OPENAI_API,
  defaultModel = DEFAULT_MODEL,
  effort = DEFAULT_EFFORT,
  keepCause = platformConfig.APP_ENV !== "production",
}: OpenAIOptions): PortImplementation<typeof llmPort> {
  const openai = createOpenAI({ apiKey, baseURL });
  const served = modelsAt(effort, defaultModel);
  const info = (modelId: string) => ({ vendor: "openai", modelId, priceListVersion: PRICE_LIST });
  return {
    getModel: async ({ modelRef, onUsage }) => {
      if (!served.includes(modelRef)) {
        const reason = "a model the adapter does not serve at its reasoning effort";
        throw new AppError(llmPort.codes.input, {
          details: { method: "getModel", reason, modelRef, effort },
        });
      }
      const model = ours(openai.responses(modelRef), effort, keepCause);
      return { ...info(modelRef), model: bindModel(model, onUsage, { keepCause }) };
    },
    listModels: async () => served.map(info),
  };
}

/** The variables' faults, one line each, naming the choices: the effort, else the default model. */
function faults(effort: string, defaultModel: string): string[] {
  if (!isEffort(effort)) return [`LLM_OPENAI_REASONING_EFFORT: one of ${EFFORTS.join(", ")}`];
  const served = modelsAt(effort);
  if (served.includes(defaultModel)) return [];
  return [
    `LLM_MODEL_DEFAULT: one of ${served.join(", ")} at LLM_OPENAI_REASONING_EFFORT=${effort}`,
  ];
}

export const openaiAdapter = defineAdapter(llmPort, {
  name: "openai",
  requires: ["LLM_OPENAI_API_KEY"],
  create: () => {
    const {
      LLM_OPENAI_API_KEY: apiKey,
      LLM_MODEL_DEFAULT: defaultModel,
      LLM_OPENAI_REASONING_EFFORT: effort,
    } = openaiConfig;
    const variables = [
      ...(apiKey ? [] : ["LLM_OPENAI_API_KEY: required by the openai adapter"]),
      ...faults(effort, defaultModel),
    ];
    if (!apiKey || !isEffort(effort) || variables.length > 0) {
      throw new AppError("config_invalid", { details: { block: "packages/providers", variables } });
    }
    return openaiLlm({ apiKey, defaultModel, effort });
  },
});
