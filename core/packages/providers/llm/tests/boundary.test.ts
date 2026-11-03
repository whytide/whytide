// The boundary of a model call (llm/boundary.ts), port-level, beside the contract's case: a tool of
// any kind but a function tool (the spec's `provider`, AI SDK 5's `provider-defined`, an unknown or
// a missing kind) and call-level provider options with an own enumerable key fail with exactly
// { method, reason }, generated or streamed, and the model is never called. A function tool
// reaches the model as it was given, and provider options with no such key (empty, or an inherited
// or a non-enumerable `anthropic`) as a fresh {}. `pnpm -F providers test:contract` runs it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4FunctionTool,
  LanguageModelV4ProviderTool,
} from "@ai-sdk/provider";
import { isAppError } from "@whytide/platform";
import { bindModel } from "../boundary.ts";
import { llmPort } from "../port.ts";

const prompt: LanguageModelV4CallOptions["prompt"] = [
  { role: "user", content: [{ type: "text", text: "Say yes." }] },
];
const webFetch = {
  type: "provider",
  id: "anthropic.web_fetch_20250910",
  name: "web_fetch",
  args: {},
} as const;
const lookup: LanguageModelV4FunctionTool = {
  type: "function",
  name: "lookup",
  inputSchema: { type: "object", properties: {} },
};
const mcpServers = [{ type: "url", url: "https://example.test/mcp", name: "x" }];

/** A vendor's model that records the options of every call it gets; it answers generated calls. */
function recording(calls: LanguageModelV4CallOptions[]): LanguageModelV4 {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  return {
    specificationVersion: "v4",
    provider: "vendor",
    modelId: "vendor-model",
    supportedUrls: {},
    doGenerate: async (options) => {
      calls.push(options);
      const finishReason = { unified: "stop", raw: undefined } as const;
      return { content: [{ type: "text", text: "yes" }], finishReason, usage, warnings: [] };
    },
    doStream: async (options) => {
      calls.push(options);
      throw new Error("not used");
    },
  };
}

/** Every call fails, generated or streamed, with { method, reason }; none reaches the model. */
async function refused(calls: Partial<LanguageModelV4CallOptions>[], reason: string) {
  const received: LanguageModelV4CallOptions[] = [];
  const model = bindModel(recording(received), () => {});
  for (const options of calls) {
    for (const method of ["doGenerate", "doStream"] as const) {
      const call = Promise.resolve(model[method]({ prompt, ...options }));
      const error = await call.catch((e: unknown) => e);
      assert.ok(isAppError(error) && error.code === llmPort.codes.input, String(error));
      assert.deepEqual(error.details, { method: "model", reason });
    }
  }
  assert.deepEqual(received, []);
}

test("a tool of any kind but a function tool: llm_input_invalid, { method, reason } only, the model never called", async () => {
  const { type: _provider, ...untyped } = webFetch;
  const kinds: unknown[] = [
    webFetch,
    { ...webFetch, type: "provider-defined" },
    { ...webFetch, type: "server" },
    untyped,
  ];
  const calls = kinds.map((tool) => ({ tools: [lookup, tool as LanguageModelV4ProviderTool] }));
  await refused(calls, "a provider-defined tool: offer function tools only");
});

test("call-level provider options, any key with any value: llm_input_invalid, { method, reason } only, the model never called", async () => {
  const values: LanguageModelV4CallOptions["providerOptions"][] = [
    { anthropic: { mcpServers } },
    { anthropic: {} },
    { other: { any: 1 } },
  ];
  const calls = values.map((providerOptions) => ({ providerOptions }));
  await refused(calls, "provider options on the call: set none");
});

test("function tools reach the model as given; provider options with no own enumerable key, as a fresh {}", async () => {
  const calls: LanguageModelV4CallOptions[] = [];
  const model = bindModel(recording(calls), () => {});
  // A vendor reads providerOptions.anthropic, which finds an inherited or a non-enumerable key too.
  const anthropic = { mcpServers };
  const values: LanguageModelV4CallOptions["providerOptions"][] = [
    {},
    Object.create({ anthropic }),
    Object.defineProperty({}, "anthropic", { value: anthropic }),
  ];
  for (const providerOptions of values) {
    await model.doGenerate({ prompt, tools: [lookup], providerOptions });
    // The recording model throws once it has recorded a streamed call.
    await assert.rejects(async () => model.doStream({ prompt, tools: [lookup], providerOptions }));
  }
  // Read the vendor's key as the vendor does. This check is what catches both keys: deepEqual,
  // below, lets a non-enumerable key pass and, on Node 26.12, an inherited one too.
  for (const call of calls) assert.equal(call.providerOptions?.anthropic, undefined);
  // Twice per value, generated then streamed.
  const fresh = { prompt, tools: [lookup], providerOptions: {} };
  assert.deepEqual(
    calls,
    values.flatMap(() => [fresh, fresh]),
  );
});
