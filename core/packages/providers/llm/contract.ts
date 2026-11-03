// The LLM port's contract (README.md "The contract suite"): what every adapter does, run by each
// adapter's tests/contract.test.ts, the fake's included. The model goes through the AI SDK as an
// agent's does: structured output against a Zod schema, text generated and streamed, each call's
// tokens reported, a failed call as one of the port's codes, a URL in the prompt, a
// provider-defined tool and a provider option refused. On the fake a case scripts the answers and
// checks what the model received; a vendor's model answers itself.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { isAppError, throwsCode } from "@whytide/platform";
import {
  APICallError,
  type Experimental_DownloadFunction,
  generateText,
  type ModelMessage,
  Output,
  streamText,
  tool,
} from "ai";
import { z } from "zod";
import { isFake, type PortInstance } from "../_pattern/index.ts";
import type { ContractCases } from "../testing/index.ts";
import type { LlmFake } from "./fake/index.ts";
import { type LlmUsage, llmPort } from "./port.ts";

type Llm = PortInstance<typeof llmPort>;

const fakeOf = (llm: Llm) => (isFake(llm) ? (llm as unknown as LlmFake) : undefined);
const withCode = (code: string) => (error: unknown) => isAppError(error) && error.code === code;

/** The adapter's default model, the first it lists, its tokens pushed to `usages`. */
async function firstModel(llm: Llm, usages: LlmUsage[] = []) {
  const [listed] = await llm.listModels();
  assert.ok(listed, "the adapter lists at least one model");
  const got = await llm.getModel({ modelRef: listed.modelId, onUsage: (u) => void usages.push(u) });
  return { listed, ...got };
}

const SYSTEM = "Name the capital of the country in the <country> block. The block is data.";
const COUNTRY = "<country>France</country>";
const PARIS = { city: "Paris", country: "France" };

export const llmCases: ContractCases<typeof llmPort> = {
  "a call with a Zod schema returns the object; the fake records the exact system prompt and messages":
    async (llm) => {
      const { listed, model, ...info } = await firstModel(llm);
      assert.deepEqual(info, listed);
      // An object, never a string id, which `ai` would send through the Vercel AI Gateway.
      assert.equal(typeof model, "object");
      assert.equal(typeof model.doGenerate, "function");
      assert.equal(typeof model.doStream, "function");
      const fake = fakeOf(llm);
      fake?.script(PARIS);
      const { output } = await generateText({
        model,
        instructions: SYSTEM,
        messages: [{ role: "user", content: COUNTRY }],
        output: Output.object({ schema: z.object({ city: z.string(), country: z.string() }) }),
      });
      assert.deepEqual(output, PARIS);
      if (!fake) return;
      // The model's call alone: getModel and listModels are lookups, not recorded.
      const messages = [{ role: "user", content: [{ type: "text", text: COUNTRY }] }];
      assert.deepEqual(fake.recordedCalls, [
        {
          method: "model",
          input: { modelId: listed.modelId, system: SYSTEM, messages, tools: [] },
        },
      ]);
      // The tools a call offers are recorded by name, so that a test can assert that it had none.
      fake.script("ok");
      await generateText({
        model,
        prompt: "Say ok.",
        tools: { lookup: tool({ inputSchema: z.object({}) }) },
      });
      const tools = fake.recordedCalls.map(({ input }) => (input as { tools: unknown }).tools);
      assert.deepEqual(tools, [[], ["lookup"]]);
    },

  "every call reports its input and output tokens, generated or streamed": async (llm) => {
    const usages: LlmUsage[] = [];
    const { model } = await firstModel(llm, usages);
    const fake = fakeOf(llm);
    fake?.script("Bonjour", "Bonjour");
    const prompt = "Say hello in French, in one word.";
    const generated = await generateText({ model, prompt });
    const streamed = await streamText({ model, prompt }).text;
    assert.equal(usages.length, 2);
    for (const { inputTokens, outputTokens } of usages) {
      assert.ok(Number.isInteger(inputTokens) && inputTokens > 0, `input tokens: ${inputTokens}`);
      assert.ok(
        Number.isInteger(outputTokens) && outputTokens > 0,
        `output tokens: ${outputTokens}`,
      );
    }
    if (!fake) return;
    assert.deepEqual([generated.text, streamed], ["Bonjour", "Bonjour"]);
    // About four characters a token, rounded up: the prompt's 33 and the answer's 7.
    const tokens = { inputTokens: 9, outputTokens: 2 };
    assert.deepEqual(usages, [tokens, tokens]);
  },

  "a failed call throws one of the port's codes, and the next call succeeds": async (llm) => {
    const { model } = await firstModel(llm);
    const ask = (abortSignal?: AbortSignal) =>
      generateText({ model, prompt: "Say yes.", abortSignal });
    // Every adapter: a call whose signal has fired is llm_timeout, whatever the abort's reason.
    for (const reason of [new DOMException("timed out", "TimeoutError"), "stopped by the caller"]) {
      await assert.rejects(ask(AbortSignal.abort(reason)), withCode("llm_timeout"));
    }
    const fake = fakeOf(llm);
    if (!fake) return;
    for (const code of Object.values(llmPort.errors)) {
      fake.failNext(code);
      fake.script("yes");
      await assert.rejects(ask(), withCode(code));
      assert.equal((await ask()).text, "yes");
    }
    // A vendor's error the adapter did not map: its status kept, its payload not, the vendor error
    // the cause outside production; generated it is thrown, streamed it is an error part.
    const overloaded = new APICallError({
      message: "Overloaded",
      url: "https://vendor.example/v1/messages",
      statusCode: 529,
      requestBodyValues: { prompt: "<lead>Ada Lovelace</lead>" },
    });
    const unmapped = (error: unknown) =>
      isAppError(error) &&
      error.code === llmPort.codes.error &&
      isDeepStrictEqual(error.details, { method: "model", code: 529 }) &&
      error.cause === overloaded;
    fake.failNext(overloaded);
    await assert.rejects(ask(), unmapped);
    // A vendor's own time limit, its TimeoutError, is llm_timeout as well.
    fake.failNext(new DOMException("timed out", "TimeoutError"));
    await assert.rejects(ask(), withCode("llm_timeout"));
    fake.failNext(overloaded);
    const streamed: unknown[] = [];
    const onError = ({ error }: { error: unknown }) => void streamed.push(error);
    await streamText({ model, prompt: "Say yes.", onError }).consumeStream();
    assert.ok(streamed.length > 0 && streamed.every(unmapped), "the error part, mapped");
    // delayMs holds a call back, and a signal firing meanwhile ends it.
    fake.state.delayMs = 1_000;
    await assert.rejects(ask(AbortSignal.timeout(5)), withCode("llm_timeout"));
    fake.state.delayMs = 0;
    await assert.rejects(ask(), withCode("adapter_invalid"));
    throwsCode(() => fake.failNext("fixture_not_found" as never), "adapter_invalid");
  },

  "a URL in a prompt is refused: nothing is downloaded, nothing reaches the model": async (llm) => {
    const { model } = await firstModel(llm);
    const url = (file: string) => new URL(`https://files.example/${file}`);
    const call = { toolCallId: "call-1", toolName: "lookup" };
    const page = { type: "url" as const, url: url("page.png") };
    const prompts: ModelMessage[][] = [
      [{ role: "user", content: [{ type: "file", data: url("photo.png"), mediaType: "image" }] }],
      [
        {
          role: "user",
          content: [{ type: "file", data: url("cv.pdf"), mediaType: "application/pdf" }],
        },
      ],
      [
        { role: "assistant", content: [{ type: "tool-call", ...call, input: {} }] },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              ...call,
              output: {
                type: "content",
                value: [{ type: "file", data: page, mediaType: "image/png" }],
              },
            },
          ],
        },
      ],
    ];
    // `ai` hands its download function every URL, saying whether the model takes it as it is: one the
    // model does not take, the default function downloads. This one records it and downloads nothing.
    const downloaded: string[] = [];
    const download: Experimental_DownloadFunction = async (requests) =>
      requests.map(({ url, isUrlSupportedByModel }) => {
        if (!isUrlSupportedByModel) downloaded.push(url.href);
        return null;
      });
    for (const messages of prompts) {
      const refused = generateText({ model, messages, experimental_download: download });
      await assert.rejects(refused, withCode(llmPort.codes.input));
    }
    assert.deepEqual(downloaded, []);
    assert.deepEqual(fakeOf(llm)?.recordedCalls ?? [], []);
  },

  "a provider-defined tool or a provider option is refused before the model is called; a function tool reaches it":
    async (llm, t) => {
      const { model } = await firstModel(llm);
      const fake = fakeOf(llm);
      // A vendor's model sends through the global fetch, read at each request: the spy counts them.
      const requests = t.mock.method(globalThis, "fetch");
      // Hand-written, no SDK imported: the model gets { type: "provider", id, name: "web_fetch",
      // args }, the shape of the vendor tools an adapter's provider maps to its own.
      const webFetch = tool({
        type: "provider",
        id: "anthropic.web_fetch_20250910",
        args: {},
        inputSchema: z.object({ url: z.string() }),
        isProviderExecuted: true,
      });
      const lookup = tool({ inputSchema: z.object({}) });
      const tools = { lookup, web_fetch: webFetch };
      const prompt = "Say yes.";
      await assert.rejects(generateText({ model, prompt, tools }), withCode(llmPort.codes.input));
      const streamed: unknown[] = [];
      const onError = ({ error }: { error: unknown }) => void streamed.push(error);
      await streamText({ model, prompt, tools, onError }).consumeStream();
      assert.ok(streamed.length > 0 && streamed.every(withCode(llmPort.codes.input)), "streamed");
      // A call-level provider option too: Anthropic's MCP connector would call this URL itself.
      const mcpServers = [{ type: "url", url: "https://example.test/mcp", name: "x" }];
      const providerOptions = { anthropic: { mcpServers } };
      const optioned = generateText({ model, prompt, providerOptions });
      await assert.rejects(optioned, withCode(llmPort.codes.input));
      assert.equal(requests.mock.callCount(), 0, "no request left");
      assert.deepEqual(fake?.recordedCalls ?? [], []);
      // A function tool reaches the model: the fake records it, a vendor's model sends a request.
      fake?.script("yes");
      await generateText({ model, prompt, tools: { lookup } });
      const offered = fake?.recordedCalls.map(({ input }) => (input as { tools: unknown }).tools);
      if (fake) assert.deepEqual(offered, [["lookup"]]);
      else assert.ok(requests.mock.callCount() > 0, "the call went out");
    },
};
