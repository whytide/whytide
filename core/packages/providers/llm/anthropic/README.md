# anthropic: the LLM port's Anthropic adapter

**Covers.** `getModel` and `listModels` of the [LLM port](../README.md), on Anthropic's Messages API through the AI SDK's Anthropic provider, `@ai-sdk/anthropic` 4.0.79. That package is imported in this folder only, and Anthropic's own SDK, `@anthropic-ai/sdk`, is listed with it though unused (`tools/lint/vendor-sdks.json`). Every model the adapter hands out goes through `bindModel` (the port's README, "The boundary of a model call"): its calls fail with the port's codes, refuse a URL in a prompt, a provider-defined tool and call-level provider options, so that none of Anthropic's server tools, nor its MCP connector, runs, and report their tokens to `onUsage`.

**Models.** `listModels()` lists `LLM_MODEL_DEFAULT` first, the model the contract's cases run on, then the current Opus, Sonnet and Haiku: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`. `getModel` serves those and answers any other `modelRef` with `llm_input_invalid`; `LLM_MODEL_DEFAULT` names one of them, and `create()` refuses any other with `config_invalid`. The default is `claude-opus-5-5`, Anthropic's recommended model on 2026-10-21; since it refuses forced tool use, the provider asks it for structured output natively (`output_config.format`) when a call passes a schema. The evals of alpha-p10-050 may change the default. A model is added with a line in `index.ts`, never by a variable; its cost events need its price in `COST_PRICES_JSON` (the platform README, "Cost events"), from [Anthropic's pricing](https://platform.claude.com/docs/en/about-claude/pricing). `priceListVersion` is `anthropic-2026-10-21`, the day the list was checked, and only informational.

**Vendor and terms.** Anthropic PBC, the account the key belongs to: the owner's organization in development and on Whytide Cloud, an operator's own on a self-hosted Core. What Anthropic's public pages say, as read on 2026-10-21, is listed here to be confirmed against the account's signed agreement, which governs; none of it is a guarantee of this code:

- The [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms) (effective 2025-06-17), section B: "Anthropic may not train models on Customer Content from Services." Section C: data submitted through the services is processed under the [Data Processing Addendum](https://www.anthropic.com/legal/data-processing-addendum), incorporated by reference.
- [Is my data used for model training?](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-training): by default, the inputs and outputs of the commercial products, the Anthropic API among them, are not used for training, unless the customer reports feedback or bugs or otherwise allows it.
- [How long do you store my organization's data?](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data): API inputs and outputs are deleted from Anthropic's backend within 30 days of receipt or generation, except with a service of longer retention under the customer's control (the Files API, unused here), under another agreement (zero data retention), for Usage Policy enforcement (flagged inputs and outputs up to 2 years, classification scores up to 7 years) or by law; Covered Models need limited retention for safety review.

Where the account's signed agreement is kept: not recorded yet.

**Variables** (`deploy/.env.example`):

| Variable | |
|---|---|
| `LLM_ANTHROPIC_API_KEY` (secret) | the account's key. Optional at import: `create()` fails with `config_invalid`, naming the variable, never the value, while it is empty, and `requires` names it, so the contract suite skips meanwhile. In development, a key with a small spending limit set in the Claude Console, through the environment (docs/rules/delivery.md §2) |
| `LLM_MODEL_DEFAULT` | the model listed first, one of the three above; `claude-opus-5-5` by default |

The base URL, `https://api.anthropic.com/v1`, is set in code: the provider's own `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` are never read.

**Network.** Every model call is one HTTPS request from the process that makes it, the worker, to `api.anthropic.com`, through the SDK's own `fetch` rather than the egress client, as docs/rules/security.md §5 allows inside a vendor adapter. It carries the key in its `x-api-key` header and the prompt, the system text and messages of an agent's call, which may hold lead data, anonymized and delimited by the caller (security §6); the answer comes back on it. Anthropic keeps both as the terms above say.

**Provider refs.** None: the adapter stores nothing.

**Known differences.** A 401 is `llm_invalid_key`, a 429 `llm_rate_limited` and a 5xx `llm_provider_error` (Anthropic's overloaded is 529), before a stream or in it, with `{ method: "model", code: <status> }` and, outside production, the vendor error as the cause, which holds the prompt; a timeout or an abort is `llm_timeout`. The rest, a 400, 403, 404 or 413, or a connection that fails, reaches the caller as `llm_error_unmapped` with the status or `AI_APICallError`. A refusal is no error: the call answers with the finish reason `content-filter`, and a call with a schema then fails with `ai`'s `NoObjectGeneratedError` when the text holds no object that matches it.

**Tests.** `tests/contract.test.ts`, run by `pnpm -F providers test:contract`, holds all of them:

- the port's contract suite against Anthropic, with a made-up key that must come back as `llm_invalid_key` with no fragment of it in the error; skipped while `LLM_ANTHROPIC_API_KEY` is empty in the environment (`.env.local` is not read; `LLM_ANTHROPIC_API_KEY=… pnpm -F providers test:contract` runs it);
- always and offline, with a key made up for the run: the same suite against a local stand-in for the Messages API; the codes above, with the key in no error, cause or log, inside and outside production; the models; the base URL and the key from code, with the provider's own variables set as decoys; `create()` in a child process, under `APP_ENV=production` and misconfigured; and the lint that keeps both SDKs in this folder.
