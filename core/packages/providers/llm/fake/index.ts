// The LLM port's fake (README.md "The fake", llm/README.md): an in-memory model that answers with
// the next scripted output, a string as text and anything else as its JSON, for the module tests and
// the Compose smoke test. It validates nothing: the AI SDK parses structured output and the agent
// call wrapper (alpha-p1-140) validates it. Its controls act on the model's calls, the ones a Mastra
// agent makes, never on getModel and listModels, which are lookups: recordedCalls holds what each
// model call received, failNext fails the next model call, state.delayMs holds each one back. So the
// lookups are set on the fake unwrapped, and failNext queues for the model instead of the port.
import { setTimeout as sleep } from "node:timers/promises";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4FinishReason,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { AppError, isAppError } from "@whytide/platform";
import {
  createFake,
  defineAdapter,
  type Fake,
  type FakeContext,
  type PortErrorCode,
  type PortImplementation,
  patternErrors,
} from "../../_pattern/index.ts";
import { bindModel } from "../boundary.ts";
import { llmPort } from "../port.ts";

/** What a model call answers: a string is the text, anything else is sent as its JSON. */
export type ScriptedOutput = string | object;
type State = { outputs: ScriptedOutput[]; failures: Error[]; delayMs: number };
type Context = FakeContext<typeof llmPort, State>;
type Controls = {
  script(...outputs: ScriptedOutput[]): void;
  failNext(failure: PortErrorCode<typeof llmPort> | Error, details?: Record<string, unknown>): void;
};
/** The fake with its controls, `script` and the model's `failNext`, for a module's tests (llm/README.md). */
export type LlmFake = Fake<typeof llmPort, State, Controls>;

const FAKE_MODEL = { vendor: "fake", modelId: "fake-model", priceListVersion: "fake" };
const STOP: LanguageModelV4FinishReason = { unified: "stop", raw: undefined };
/** About four characters a token, rounded up: counts a test can work out. */
const tokens = (text: string) => Math.ceil(text.length / 4);

function textOf(prompt: LanguageModelV4Prompt): string {
  let text = "";
  for (const message of prompt) {
    if (typeof message.content === "string") text += message.content;
    else for (const part of message.content) if (part.type === "text") text += part.text;
  }
  return text;
}

/**
 * One model call: recorded, held back by delayMs, failed by failNext, answered with the next output.
 * A vendor's error the adapter did not map comes back, for doGenerate to throw and doStream to send.
 */
async function answer(fake: Context, modelId: string, options: LanguageModelV4CallOptions) {
  const { prompt, abortSignal, tools = [] } = options;
  const system = prompt.flatMap((m) => (m.role === "system" ? [m.content] : [])).join("\n\n");
  const messages = prompt.filter((m) => m.role !== "system");
  // As JSON, without the AI SDK's undefined keys, so that a test compares it with a literal.
  fake.record("model", {
    modelId,
    system,
    messages: JSON.parse(JSON.stringify(messages)),
    tools: tools.map((tool) => tool.name),
  });
  // An abort fails the call as a vendor's would, and the boundary makes it llm_timeout.
  abortSignal?.throwIfAborted();
  if (fake.state.delayMs > 0) await sleep(fake.state.delayMs, undefined, { signal: abortSignal });
  const failure = fake.state.failures.shift();
  if (isAppError(failure)) throw failure;
  if (failure) return { vendorError: failure };
  const output = fake.state.outputs.shift();
  if (output === undefined) {
    throw new AppError(patternErrors.adapter_invalid, {
      details: { port: llmPort.name, adapter: "fake", reason: "no scripted output" },
    });
  }
  const text = typeof output === "string" ? output : JSON.stringify(output);
  const [input, generated] = [tokens(textOf(prompt)), tokens(text)];
  const usage = {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: generated, text: generated, reasoning: 0 },
  };
  return { text, usage };
}

function fakeModel(fake: Context, modelId: string): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: FAKE_MODEL.vendor,
    modelId,
    supportedUrls: {},
    async doGenerate(options) {
      const answered = await answer(fake, modelId, options);
      if ("vendorError" in answered) throw answered.vendorError;
      const { text, usage } = answered;
      return { content: [{ type: "text", text }], finishReason: STOP, usage, warnings: [] };
    },
    async doStream(options) {
      const answered = await answer(fake, modelId, options);
      const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
      // Once a vendor streams, it sends its failure as an error part.
      if ("vendorError" in answered) parts.push({ type: "error", error: answered.vendorError });
      else {
        parts.push(
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: answered.text },
          { type: "text-end", id: "text" },
          { type: "finish", finishReason: STOP, usage: answered.usage },
        );
      }
      return { stream: ReadableStream.from(parts) };
    },
  };
}

/** Any modelRef answers, under its own id, so that a task's configured model runs on the fake. */
const lookups = (fake: Context): PortImplementation<typeof llmPort> => ({
  getModel: async ({ modelRef, onUsage }) => ({
    ...FAKE_MODEL,
    modelId: modelRef,
    model: bindModel(fakeModel(fake, modelRef), onUsage),
  }),
  listModels: async () => [{ ...FAKE_MODEL }],
});

const fake = createFake(llmPort, {
  state: (): State => ({ outputs: [], failures: [], delayMs: 0 }),
  methods: lookups,
  helpers: (fake) => ({
    /** Queues the answers of the next model calls, in order. */
    script: (...outputs: ScriptedOutput[]) => void fake.state.outputs.push(...outputs),
  }),
});

export const llmFake: LlmFake = Object.assign(fake, lookups(fake), {
  /** The next model call fails with this port code, or with this Error as a vendor's; several queue up. */
  failNext(
    failure: PortErrorCode<typeof llmPort> | Error,
    details?: Record<string, unknown>,
  ): void {
    if (typeof failure === "string" && !Object.hasOwn(llmPort.errors, failure)) {
      throw new AppError(patternErrors.adapter_invalid, {
        details: {
          port: llmPort.name,
          adapter: "fake",
          reason: "a code the port does not declare",
          code: failure,
        },
      });
    }
    fake.state.failures.push(
      typeof failure === "string" ? new AppError(failure, { details }) : failure,
    );
  },
});
export const llmFakeAdapter = defineAdapter(llmPort, { name: "fake", create: () => llmFake });
