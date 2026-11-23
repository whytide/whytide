# The LLM port

Mastra agents get their model here ([architecture §8, §9](../../../../docs/architecture.md#8-background-work-temporal-and-mastra)): an AI SDK 7 language model object (`LanguageModelV4`), the kind Mastra takes, so that bring-your-own-model keeps working, with our metadata beside it. No module imports a vendor SDK; the Anthropic adapter is in `anthropic/`, the OpenAI one in `openai/`.

| File | Holds |
|---|---|
| `port.ts` | `llmPort`; `llmConfig`, re-exported; the types `LlmUsage`, `UsageCallback` and `LlmFake` |
| `config.ts` | `PROVIDER_LLM`, `fake` in development and tests |
| `boundary.ts` | `bindModel(model, onUsage)`, the boundary of a model call, which an adapter hands its model out through |
| `contract.ts` | `llmCases`, what every adapter does |
| `fake/` | the in-memory model; `fake/tests/contract.test.ts` runs the contract on it |
| `tests/` | the port-level tests: `boundary.test.ts`, the refused tools and provider options; `contract.test.ts`, a vendor's stream failing |
| `anthropic/` | the Anthropic adapter; [its README](anthropic/README.md) has the vendor's terms, the key and the models |
| `openai/` | the OpenAI adapter; [its README](openai/README.md) has the vendor's terms, the key, the models and the reasoning effort |

## The port

- `getModel({ modelRef, onUsage })` returns `{ model, vendor, modelId, priceListVersion }` for `modelRef`, a `modelId` the adapter serves; an adapter answers one it does not serve with `llm_input_invalid`. `model` is opaque at the port: outside production, `z.custom` checks that it is a v4 model object (`doGenerate`, `doStream`), and passes it through. `vendor` and `modelId` are what a cost event records. `priceListVersion` is informational: the cost event's price version is the platform price table's, which `recordCost` stamps (`platform/cost/prices.ts`), and alpha-p1-140 takes it from there.
- `listModels()`: the models the adapter serves, with the same metadata, its default first; the contract's cases run on that one.
- Codes: `llm_rate_limited` (429), `llm_timeout` (the vendor's limit, or the caller's abort signal fired), `llm_invalid_key`, `llm_provider_error` (any other failure of the vendor's); the pattern adds `llm_input_invalid`, `llm_output_invalid` and `llm_error_unmapped`.
- A method is added with its case in `contract.ts`.

## The boundary of a model call

The port's boundary sees `getModel` and `listModels`, never the calls of the model they hand out, so an adapter hands its model out through `bindModel(model, onUsage)`. Every call of it then refuses a URL in its prompt, a provider-defined tool and call-level provider options (Security, below), and:

- Fails with the port's codes only, as an `AppError`. An adapter maps the vendor errors it knows inside its own model: 429 to `llm_rate_limited`, 401 to `llm_invalid_key`, 5xx to `llm_provider_error`, its timeouts to `llm_timeout`. The boundary catches the rest: an `AppError` passes as it is; an abort (`AbortError`, `TimeoutError`, or any error once the call's signal has fired) is `llm_timeout`; anything else is `llm_error_unmapped` with `{ method: "model", code }`, the vendor's status or short name, never its message or payload, the vendor error kept as the cause outside production only (`bindModel`'s `keepCause` sets it by hand). A stream's error parts and a stream that fails are mapped alike.
- Reaches the caller as `ai` passes it on. `generateText` throws the code. `streamText` hands a failed `doStream` or an error part to `onError`: after the first its `text` rejects with `NoOutputGeneratedError`, after the second it resolves with the text so far, so a caller watches `onError`; a stream that fails rejects `fullStream` and `text` with the code. A stream the caller aborts ends through `ai`'s own `onAbort` instead, rejecting with the caller's reason, above the model. `ai` retries none of these: it retries its own `APICallError` only.
- Reports its tokens to `onUsage({ inputTokens, outputTokens })` once it has answered: after `doGenerate`, and at the finish part of `doStream`'s stream; a count the vendor leaves out is 0. A call that fails reports nothing, nor does a stream aborted, failed or cancelled before its finish part, so such a call's cost event has no tokens. `onUsage` is called synchronously: a promise it returns is not awaited, and its rejection goes unhandled. It is bound at `getModel`: get a model per agent call.

Security: never pass a model as a string id, since `ai` routes a string through the Vercel AI Gateway, a way out of the system that no adapter declares. The port hands out model objects only; its output check runs outside production, and the contract checks it on every adapter. A URL in a prompt's file or image part, a tool result's included, fails with `llm_input_invalid` before anything is fetched, since `ai` would download it itself, or the vendor fetch it, outside the egress client: send files as data. Any tool but a function tool, a provider-defined one (`type: "provider"`, such as Anthropic's `web_fetch`, `web_search` or code execution, hand-written or not), fails the same way before the model is called, with `{ method: "model", reason }`, since the vendor's servers would run it outside the egress client; function tools reach the model as they are given. A call whose call-level provider options have an own enumerable key, whatever the key and its value, fails the same way, the reason naming provider options and never their values: Anthropic's `mcpServers` alone has its servers call a URL the caller names, outside the egress client. Any other provider options object, empty or with only inherited or non-enumerable keys, which a vendor reads as well, reaches the model as a fresh `{}`. There is no allow-list for either: a task that needs a provider tool or option (Anthropic's thinking or cache options, say) adds one, with a security review. No key, vendor object or prompt crosses the port or reaches a log line.

## The fake

`PROVIDER_LLM=fake`. One model, `fake-model` (vendor `fake`, price list `fake`); it accepts any `modelRef` too, under its own id, so that a development stack on the fake can carry real model ids. It validates nothing: the AI SDK parses structured output and the agent call wrapper of alpha-p1-140 validates it. Its controls act on the model's calls, the ones a Mastra agent makes; `getModel` and `listModels` are lookups, neither recorded nor failed:

| Control | Does |
|---|---|
| `script(...outputs)` | queues the answers of the next model calls, in order: a string is the text, anything else is sent as its JSON. A call with nothing left fails with `adapter_invalid` |
| `recordedCalls` | one entry per model call since the last reset, `{ method: "model", input: { modelId, system, messages, tools } }`: `system` is the system messages' text, joined by a blank line; `messages` the others as the model received them, the AI SDK's prompt parts, as JSON; `tools` the names of the tools the call offered, so that a test can assert that a scoring call offered none |
| `failNext(code, details?)` | the next model call throws that port code and the one after answers; several queue up; a code the port does not declare is `adapter_invalid` |
| `failNext(error)` | the next model call fails with that `Error`. An `AppError` is thrown unchanged, as an adapter's own; any other is a vendor's own, unmapped: `doGenerate` throws it, `doStream` sends it as an error part, and the boundary maps it, an `AbortError` or `TimeoutError` to `llm_timeout` and only the rest to `llm_error_unmapped` |
| `state.delayMs` | holds each model call back that long; an abort signal that fires first ends it, as `llm_timeout` |
| `reset()` | empties all of it; the contract suite resets the fake before each case |

The tokens it reports are four characters a token, rounded up: the prompt's text in, the answer's out.

## Scripting it from a module's tests

The registry hands a test the instance the module gets, and `LlmFake` types its controls:

```ts
import { getAdapter, isFake, type LlmFake, llmPort } from "@whytide/providers";

const llm = await getAdapter(llmPort, "fake");
assert.ok(isFake(llm));
const fake = llm as unknown as LlmFake;
fake.reset();
fake.script({ verdict: "met" });
// … the code under test runs its agent …
assert.equal(fake.recordedCalls.length, 1);
assert.doesNotMatch(JSON.stringify(fake.recordedCalls), /Ada Lovelace/); // security §6: anonymized
```
