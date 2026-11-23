# openai: the LLM port's OpenAI adapter

**Covers.** `getModel` and `listModels` of the [LLM port](../README.md), on OpenAI's Responses API through the AI SDK's OpenAI provider, `@ai-sdk/openai` 4.0.93, imported in this folder only (`tools/lint/vendor-sdks.json`). `PROVIDER_LLM=openai` selects it. Every model the adapter hands out goes through `bindModel` (the port's README, "The boundary of a model call"): its calls fail with the port's codes, refuse a URL in a prompt, a provider-defined tool (OpenAI's web search, file search, code interpreter, MCP and the like) and call-level provider options, and report their tokens to `onUsage`.

**What every call sets.** Below `bindModel`, which refuses the caller's own provider options, the adapter's model sets these on every call itself, so that no caller can change them:

- `reasoningEffort`, from `LLM_OPENAI_REASONING_EFFORT`: one effort for every task, the owner's choice;
- `store: false`: OpenAI keeps no response for retrieval (the Responses API keeps one 30 days by default), and the app never reads one back. The SDK then asks for the reasoning's encrypted content (`include: ["reasoning.encrypted_content"]`), which comes back with the answer and is kept nowhere;
- `reasoningSummary: null`: no reasoning summary, which the SDK otherwise asks for (`detailed`) and the app never reads; the request simply has no `reasoning.summary`;
- `strictJsonSchema: true`: a schema is sent strict, in the subset strict mode supports (below, "Known differences"), and the app validates every answer against the whole schema with Zod anyway;
- the headroom, below.

The model reports its own provider id, `whytide-openai.responses`, never one that starts with `openai`: for such a model Mastra adds `providerOptions.openai.strictJsonSchema` to every call with a schema, and `bindModel` refuses that call, as it refuses every caller's provider option, so every agent call would fail with `llm_input_invalid`. Under this id Mastra adds nothing, and the schema it hands the model is the one the AI SDK's own conversion makes, which the strict-mode test checks (compared by hand for the seven tasks); the adapter sets `strictJsonSchema` itself.

**Models.** `listModels()` lists `LLM_MODEL_DEFAULT` first, the model the contract's cases run on, then the others the effort serves. The efforts are none, low, medium, high, xhigh and max, and the SDK sends a model only the efforts it knows for it (its `getOpenAILanguageModelCapabilities`): an effort it drops would leave the model reasoning at the API's default, medium. So the adapter serves a model only at an effort the SDK sends; at `none`, `gpt-6-sol` and `gpt-6-luna` alone, at any other effort all five. As read on OpenAI's model pages on 2026-11-02:

| Model | | Price per 1M tokens, input/output | Efforts the API takes | Efforts the SDK sends |
|---|---|---|---|---|
| `gpt-6.1-sol` | the default, OpenAI's balanced model | $2 / $10 | low to max | low to max |
| `gpt-6-astra` | the flagship | $10 / $50 | low to max | low to max |
| `gpt-6.1-terra` | fast | $1 / $5 | none to max | low to max: the SDK predates it and drops none |
| `gpt-6-luna` | the cheapest | $0.10 / $0.50 | none to max | none to max |
| `gpt-6-sol` | the older Sol | $2 / $10 | none to max | none to max |

`getModel` answers any other `modelRef`, or one the effort does not serve (an `AI_MODEL_*` override), with `llm_input_invalid`; `create()` refuses an `LLM_MODEL_DEFAULT` the effort does not serve with `config_invalid`, naming the choices. A model is added with a line in `constants.ts`, never by a variable. Its cost events need its price in `COST_PRICES_JSON` (the platform README, "Cost events"), per token; the five, inside `prices`:

```json
"openai":{"gpt-6.1-sol":{"input_tokens":0.000002,"output_tokens":0.00001},"gpt-6-astra":{"input_tokens":0.00001,"output_tokens":0.00005},"gpt-6.1-terra":{"input_tokens":0.000001,"output_tokens":0.000005},"gpt-6-luna":{"input_tokens":0.0000001,"output_tokens":0.0000005},"gpt-6-sol":{"input_tokens":0.000002,"output_tokens":0.00001}}
```

At start the worker's `checkAgentPrices` refuses a task's model that has no price (`cost_price_missing`). `priceListVersion` is `openai-2026-11-02`, the day the list was checked, and only informational.

**Vendor and terms.** OpenAI, the account the key belongs to: the owner's organization in development and on Whytide Cloud, an operator's own on a self-hosted Core. What OpenAI's [Data controls in the OpenAI platform](https://developers.openai.com/api/docs/guides/your-data) says, as read on 2026-11-02, is listed here to be confirmed against the account's agreement, which governs; none of it is a guarantee of this code:

- data sent to the API is not used to train or improve OpenAI's models unless the customer opts in;
- abuse-monitoring logs, which may hold prompts and answers, are kept up to 30 days, longer when the law requires it;
- the Responses API keeps a response's application state 30 days unless `store` is false, as this adapter sets it; zero data retention, which also drops the abuse-monitoring logs, needs OpenAI's approval.

Where the account's agreement is kept: not recorded yet.

**Variables** (`deploy/.env.example`):

| Variable | |
|---|---|
| `LLM_OPENAI_API_KEY` (secret) | the account's key. Optional at import: `create()` fails with `config_invalid`, naming the variable, never the value, while it is empty, and `requires` names it, so the contract suite skips meanwhile. In development, a key with a small spending limit set in OpenAI's dashboard, through the environment (docs/rules/delivery.md §2) |
| `LLM_OPENAI_REASONING_EFFORT` | every call's effort: `none`, `low`, `medium`, `high`, `xhigh` or `max`; `medium` by default. Another value is `config_invalid` at start |
| `LLM_MODEL_DEFAULT` | the model listed first, one the effort serves; `gpt-6.1-sol` by default. The anthropic adapter reads the same variable with its own default, so one line serves either adapter: a Claude id with `PROVIDER_LLM=openai` is `config_invalid` |

The base URL, `https://api.openai.com/v1`, is set in code: the SDK's own `OPENAI_BASE_URL` and `OPENAI_API_KEY` never reach a request, and no `OPENAI_ORGANIZATION` or `OPENAI_PROJECT` is sent.

**Network.** Every model call is one HTTPS request from the process that makes it, the worker, to `api.openai.com`, through the SDK's own `fetch` rather than the egress client, as docs/rules/security.md §5 allows inside a vendor adapter. It carries the key in its `Authorization` header and the prompt, the system text and messages of an agent's call, which may hold lead data, anonymized and delimited by the caller (security §6); the answer comes back on it, streamed when Mastra streams. OpenAI keeps both as the terms above say.

**Provider refs.** None: the adapter stores nothing.

**Known differences.**

- *Out of credits.* OpenAI answers an account out of credits with a 429 whose code is `insufficient_quota`, before a stream or in it. No wait cures it, so it is `llm_provider_error` with `{ method: "model", code: "insufficient_quota", status: 429 }`, never `llm_rate_limited`: the worker's log line names it.
- *The rest of the codes.* A 401 is `llm_invalid_key`; a 429 `llm_rate_limited`, with `retryAfterSec` from its `retry-after-ms` or `retry-after` header when it has one, which the worker waits; a 5xx `llm_provider_error`, before a stream or in it, all with `{ method: "model", code: <status> }` and, outside production, the vendor error as the cause, which holds the prompt; a timeout or an abort is `llm_timeout`. The rest, a 400, 403, 404 or 413, or a connection that fails, reaches the caller as `llm_error_unmapped` with the status or `AI_APICallError`. Details hold the status and the code word above, never OpenAI's message.
- *Strict mode's subset.* With strict on, OpenAI fails a call whose schema holds a keyword strict mode does not support ([Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), "Supported schemas", read 2026-11-02), so the adapter sends a copy of a call's response schema with only those it supports (`STRICT_KEYWORDS`, `schema.ts`): `type`, `properties`, `items`, `required`, `additionalProperties`, `enum`, `const`, `anyOf`, `description`, `$defs` and `$ref`, `pattern`, `format` as date-time, time, date, duration, email, hostname, ipv4, ipv6 or uuid, the number bounds, `minItems` and `maxItems`. It drops the rest, `minLength`, `maxLength`, another `format` (`uri`, from `z.url()`), `$schema`, `title` and `default` among them, which Zod still checks on every answer; the caller's schema is left as it is.
- *The efforts.* The table above: at `none`, two models.
- *The headroom.* Reasoning tokens count inside `max_output_tokens`, and the tasks' budgets are 500 to 16,000 tokens of answer. So when the effort is not `none`, the adapter adds 25,000 to a call's `maxOutputTokens` (`REASONING_HEADROOM`, OpenAI's guidance for reasoning plus output), and a task's budget stays its answer's room; a call without a cap keeps none. Only the tokens used are billed. The output tokens reported, and so the cost event's, include the reasoning tokens.

**Tests.** `tests/contract.test.ts` and `tests/strict-schemas.test.ts`, run by `pnpm -F providers test:contract`, on `tests/stand-in.ts`, a local stand-in for the Responses API:

- the port's contract suite against OpenAI, with a made-up key that must come back as `llm_invalid_key` with no fragment of it in the error; skipped while `LLM_OPENAI_API_KEY` is empty in the environment (`.env.local` is not read; `LLM_OPENAI_API_KEY=… pnpm -F providers test:contract` runs it);
- always and offline, with a key made up for the run: the same suite against the stand-in, generated and streamed; every call's request at every effort and model (the effort, `store: false`, no summary, the headroom, no tool, no URL); the tokens, reasoning included; the codes above, with the key in no error, cause or log, inside and outside production; the models each effort serves; the provider id, with Mastra's own option refused; the base URL and the key from code, with the `OPENAI_*` variables set as decoys; `create()` in a child process, under `APP_ENV=production` and misconfigured; the lint that keeps the SDK in this folder;
- the seven registered agent tasks' output schemas, read from their modules' files, sent through the adapter as strict `json_schema` and checked as sent against OpenAI's strict-mode rules: its keywords and formats alone, every object closed and wholly required, the limits; a `minLength`, a `maxLength` and a `uri` format dropped from the request and still enforced by Zod; the caller's schema left as it is.
