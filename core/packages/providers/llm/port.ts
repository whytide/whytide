// The LLM port (docs/architecture.md §8, §9; docs/rules/coding.md §6): Mastra agents get their model
// here, an AI SDK 7 language model (`LanguageModelV4`), which is what Mastra takes, so that
// bring-your-own-model keeps working. The model is opaque at the port: outside production, `z.custom`
// checks that it is a model object, and passes it through (README.md "The boundary"); the metadata
// beside it is in our words. The model's calls have their own boundary, bindModel() in boundary.ts:
// each fails with the port's codes only, and one that answers reports its tokens to the caller's
// `onUsage`, for the cost event; one that fails, or a stream that ends before its finish part,
// reports none. llm/README.md has the rules an adapter follows.
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { z } from "zod";
import { definePort } from "../_pattern/index.ts";

export { llmConfig } from "./config.ts";
export type { LlmFake } from "./fake/index.ts";

/** One model call's tokens, what the cost event counts (docs/rules/coding.md §9). */
export type LlmUsage = { readonly inputTokens: number; readonly outputTokens: number };
/**
 * Called synchronously, once for every model call that answered, with its tokens: a promise it
 * returns is not awaited. It is bound at getModel, so an agent call gets a model of its own.
 */
export type UsageCallback = (usage: LlmUsage) => void;

/** A model object of the AI SDK 7 specification: never a string id, which `ai` would send through the Vercel AI Gateway. */
function isModel(value: unknown): value is LanguageModelV4 {
  const model = value as Partial<LanguageModelV4> | null;
  return (
    typeof model === "object" &&
    model !== null &&
    model.specificationVersion === "v4" &&
    typeof model.doGenerate === "function" &&
    typeof model.doStream === "function"
  );
}

const modelInfo = z.strictObject({
  /** The vendor as cost events name it: `fake`, `anthropic`. */
  vendor: z.string().min(1),
  /** The vendor's id of the model: the cost event's `model`. */
  modelId: z.string().min(1),
  /** The version of the price list the model is billed under. */
  priceListVersion: z.string().min(1),
});

export const llmPort = definePort({
  name: "llm",
  methods: {
    /** The model `modelRef` names, a `modelId` the adapter serves, each answered call's tokens sent to `onUsage`. */
    getModel: {
      input: z.object({
        modelRef: z.string().min(1),
        onUsage: z.custom<UsageCallback>((value) => typeof value === "function", "a function"),
      }),
      output: modelInfo.extend({
        model: z.custom<LanguageModelV4>(isModel, "an AI SDK language model object, v4"),
      }),
    },
    /** The models the adapter serves, its default first. */
    listModels: { input: z.void(), output: z.array(modelInfo) },
  },
  errors: {
    /** The vendor's rate limit refused the call. */
    llm_rate_limited: { status: 429 },
    /** The call ran out of time: the vendor's limit, or the caller's abort signal fired. */
    llm_timeout: {},
    /** The vendor refused the key. */
    llm_invalid_key: {},
    /** Any other failure on the vendor's side. */
    llm_provider_error: {},
  },
});
