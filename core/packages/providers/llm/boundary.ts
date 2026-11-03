// The boundary of a model call (llm/README.md): bindPort() guards getModel and listModels, never the
// calls of the model they hand out, so an adapter hands its model out through bindModel(), and every
// call of it then
// - fails with ours only: an AppError as it is, an abort as llm_timeout, anything else as
//   llm_error_unmapped with the vendor's status or short name, never its message or payload, the
//   vendor error kept as the cause if keepCause, by default outside production (coding §9); a
//   stream's error parts and its failure alike;
// - takes no URL as a file's data, an image's or a tool result's included: `ai` would download it,
//   or the vendor fetch it, outside the egress client, so every URL counts as supported, which
//   keeps `ai` from downloading it, and the call is refused (a URL in text is only text);
// - takes function tools only, as given: a provider-defined tool (web fetch, web search, code
//   execution) runs on the vendor's servers, outside the egress client, so the call is refused;
// - takes no call-level provider options: an own enumerable key, whatever its value, refuses the
//   call, since Anthropic's mcpServers alone has its servers call a URL the caller names, outside
//   the egress client; any other object, empty or with an inherited or a non-enumerable key only,
//   which a vendor reads as well, reaches the model as a fresh {};
// - has no allow-list for either: a task that needs a provider tool or option adds one, with a
//   security review;
// - reports its tokens to onUsage once it has answered, for the cost event: after doGenerate, and at
//   the finish part of doStream's stream.
// Adapters import it by relative path; the package does not export it, so no host loads `ai` for it.
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { AppError, isAppError, platformConfig } from "@whytide/platform";
import { wrapLanguageModel } from "ai";
import { type LlmUsage, llmPort, type UsageCallback } from "./port.ts";

/** A count the vendor leaves out is 0: the contract suite checks that every adapter reports both. */
const tokensOf = (usage: LanguageModelV4Usage): LlmUsage => ({
  inputTokens: usage.inputTokens.total ?? 0,
  outputTokens: usage.outputTokens.total ?? 0,
});

const ABORTS = new Set<unknown>(["AbortError", "TimeoutError"]);

/** The vendor's status, else its code or name when one short word; never its message. */
function vendorCode(error: unknown): string | number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { statusCode, status, code, name } = error as Record<string, unknown>;
  return [statusCode, status, code, name].find(
    (value) => typeof value === "number" || (typeof value === "string" && /^\S{1,64}$/.test(value)),
  ) as string | number | undefined;
}

/** What a model call fails with: ours as it is, an abort as llm_timeout, anything else unmapped. */
function portError(error: unknown, signal: AbortSignal | undefined, keepCause: boolean): AppError {
  if (isAppError(error)) return error;
  // A custom abort reason is not named AbortError: the call's signal tells.
  if (signal?.aborted || ABORTS.has((error as { name?: unknown } | null | undefined)?.name)) {
    return new AppError(llmPort.errors.llm_timeout);
  }
  // The vendor error itself travels only where a person reads it, never into a production log.
  return new AppError(llmPort.codes.error, {
    details: { method: "model", code: vendorCode(error) },
    cause: keepCause ? error : undefined,
  });
}

async function guard<T>(step: () => PromiseLike<T>, fail: (e: unknown) => AppError): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw fail(error);
  }
}

/** A file part whose data is a URL, a tool result's included. */
function hasUrl(prompt: LanguageModelV4Prompt): boolean {
  return prompt.some(
    ({ content }) =>
      typeof content !== "string" &&
      content.some((part) =>
        (part.type === "tool-result" && part.output.type === "content"
          ? part.output.value
          : [part]
        ).some((inner) => "data" in inner && inner.data.type === "url"),
      ),
  );
}

/** Why the call is refused before the model sees it, never quoting the prompt; else undefined. */
function refusal({ prompt, tools = [], providerOptions }: LanguageModelV4CallOptions) {
  if (hasUrl(prompt)) return "a URL in the prompt: send files as data";
  // Any kind but a function tool: the spec's `provider` kind, and a kind a later spec adds.
  if (tools.some((tool) => tool.type !== "function")) {
    return "a provider-defined tool: offer function tools only";
  }
  // An own enumerable key, whatever its value, even {}: no option reaches a vendor unreviewed.
  if (Object.keys(providerOptions ?? {}).length > 0) {
    return "provider options on the call: set none";
  }
  return undefined;
}

/** `keepCause` keeps the vendor error as the cause; by default outside production, as bindPort does. */
export function bindModel(
  model: LanguageModelV4,
  onUsage: UsageCallback,
  { keepCause = platformConfig.APP_ENV !== "production" }: { readonly keepCause?: boolean } = {},
): LanguageModelV4 {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      // Every URL counts as supported, so that `ai` downloads none; transformParams refuses it then.
      overrideSupportedUrls: () => ({ "*": [/^/] }),
      transformParams: async ({ params }) => {
        const reason = refusal(params);
        if (reason !== undefined) {
          throw new AppError(llmPort.codes.input, { details: { method: "model", reason } });
        }
        // Provider options that pass have no own enumerable key, but a vendor reads an inherited
        // or a non-enumerable one as well: the model gets a fresh {} in their place.
        return params.providerOptions === undefined ? params : { ...params, providerOptions: {} };
      },
      wrapGenerate: async ({ doGenerate, params }) => {
        const fail = (error: unknown) => portError(error, params.abortSignal, keepCause);
        const result = await guard(doGenerate, fail);
        onUsage(tokensOf(result.usage));
        return result;
      },
      wrapStream: async ({ doStream, params }) => {
        const fail = (error: unknown) => portError(error, params.abortSignal, keepCause);
        const { stream, ...rest } = await guard(doStream, fail);
        const reader = stream.getReader();
        const ours = new ReadableStream<LanguageModelV4StreamPart>({
          // A read that fails rejects pull, which fails this stream with the mapped error.
          async pull(controller) {
            const { done, value } = await guard(() => reader.read(), fail);
            if (done) return controller.close();
            if (value.type === "finish") onUsage(tokensOf(value.usage));
            const error = value.type === "error" && fail(value.error);
            controller.enqueue(error ? { type: "error", error } : value);
          },
          cancel: (reason) => reader.cancel(reason),
        });
        return { ...rest, stream: ours };
      },
    },
  });
}
