// The Anthropic adapter of the LLM port (README.md): Anthropic's models through the AI SDK's provider,
// @ai-sdk/anthropic, imported in this folder only (tools/lint/vendor-sdks.json). The key and the default
// model come from config and are checked when the adapter starts. The base URL is passed in code, so the
// SDK never reads ANTHROPIC_BASE_URL or ANTHROPIC_API_KEY from the environment; a test passes a local
// one. Each model maps the vendor's failures it knows to the port's codes, then goes out through
// bindModel(), the boundary of every model call (llm/boundary.ts), which wraps the rest.
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { AppError, platformConfig } from "@whytide/platform";
import { wrapLanguageModel } from "ai";
import { defineAdapter, type PortImplementation } from "../../_pattern/index.ts";
import { bindModel } from "../boundary.ts";
import { llmPort } from "../port.ts";
import { anthropicConfig } from "./config.ts";

const ANTHROPIC_API = "https://api.anthropic.com/v1";
/** The day the models were checked against Anthropic's pages; informational (llm/README.md). */
const PRICE_LIST = "anthropic-2026-10-21";
/** The models served, the current Opus, Sonnet and Haiku; LLM_MODEL_DEFAULT names the one listed first. */
const CURRENT_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
const BY_STATUS = new Map<unknown, keyof typeof llmPort.errors>([
  [401, "llm_invalid_key"],
  [429, "llm_rate_limited"],
]);

export type AnthropicOptions = {
  readonly apiKey: string;
  /** Anthropic's API, unless a test names a local stand-in; never from the environment. */
  readonly baseURL?: string;
  /** The model listed first, one of CURRENT_MODELS; LLM_MODEL_DEFAULT by default. */
  readonly defaultModel?: string;
  /** Keep the vendor error as the cause; by default outside production, as bindModel does. */
  readonly keepCause?: boolean;
};

/**
 * A vendor failure this adapter knows, as the port's code: a timeout or an abort, 401, 429 and 5xx,
 * thrown or sent as a stream's error part (Anthropic's overloaded event is 529). Anything else goes
 * on as it is, for bindModel to wrap unmapped.
 */
function portError(error: unknown, signal: AbortSignal | undefined, keepCause: boolean): unknown {
  const { name, statusCode } = (error ?? {}) as { name?: unknown; statusCode?: unknown };
  // The SDK passes a timeout or an abort on as the signal's reason, an Error or not.
  if (signal?.aborted || name === "AbortError" || name === "TimeoutError") {
    return new AppError(llmPort.errors.llm_timeout);
  }
  const code =
    BY_STATUS.get(statusCode) ??
    (typeof statusCode === "number" && statusCode >= 500 ? "llm_provider_error" : undefined);
  if (code === undefined) return error;
  return new AppError(llmPort.errors[code], {
    details: { method: "model", code: statusCode },
    cause: keepCause ? error : undefined,
  });
}

async function mapping<T>(step: () => PromiseLike<T>, fail: (error: unknown) => unknown) {
  try {
    return await step();
  } catch (error) {
    throw fail(error);
  }
}

/** The vendor's model with its failures mapped, generated or streamed. */
function mapped(model: LanguageModelV4, keepCause: boolean): LanguageModelV4 {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
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

/** The adapter's implementation for a key; a test passes a local base URL and keepCause. */
export function anthropicLlm({
  apiKey,
  baseURL = ANTHROPIC_API,
  defaultModel = anthropicConfig.LLM_MODEL_DEFAULT,
  keepCause = platformConfig.APP_ENV !== "production",
}: AnthropicOptions): PortImplementation<typeof llmPort> {
  const anthropic = createAnthropic({ apiKey, baseURL });
  const served = [...new Set([defaultModel, ...CURRENT_MODELS])];
  const info = (modelId: string) => ({
    vendor: "anthropic",
    modelId,
    priceListVersion: PRICE_LIST,
  });
  return {
    getModel: async ({ modelRef, onUsage }) => {
      if (!served.includes(modelRef)) {
        throw new AppError(llmPort.codes.input, {
          details: { method: "getModel", reason: "a model the adapter does not serve", modelRef },
        });
      }
      const model = bindModel(mapped(anthropic(modelRef), keepCause), onUsage, { keepCause });
      return { ...info(modelRef), model };
    },
    listModels: async () => served.map(info),
  };
}

export const anthropicAdapter = defineAdapter(llmPort, {
  name: "anthropic",
  requires: ["LLM_ANTHROPIC_API_KEY"],
  create: () => {
    const { LLM_ANTHROPIC_API_KEY: apiKey, LLM_MODEL_DEFAULT: defaultModel } = anthropicConfig;
    const variables = [
      ...(apiKey ? [] : ["LLM_ANTHROPIC_API_KEY: required by the anthropic adapter"]),
      ...(CURRENT_MODELS.includes(defaultModel)
        ? []
        : [`LLM_MODEL_DEFAULT: one of ${CURRENT_MODELS.join(", ")}`]),
    ];
    if (!apiKey || variables.length > 0) {
      throw new AppError("config_invalid", { details: { block: "packages/providers", variables } });
    }
    return anthropicLlm({ apiKey, defaultModel });
  },
});
