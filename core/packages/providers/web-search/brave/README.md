# The brave adapter

The web-search port ([../README.md](../README.md)) on the Brave Search API, its web search. `PROVIDER_WEB_SEARCH=brave`.

## Covers

`searchWeb`, every key: one `GET https://api.search.brave.com/res/v1/web/search` per search, with `q` and `count`, and Brave's `country`, `search_lang` and `offset` when the search gives them, and nothing else. A `site` goes into `q` as Brave's operator, `<query> site:<site>`. The key travels in the `X-Subscription-Token` header and nowhere else; `Accept: application/json` is the only other header the adapter sets. No SDK: Node's fetch, from this folder only (`client.ts`).

## Country, language and page

| The port's key | Brave's parameter | Rule |
|---|---|---|
| `country` | `country` | passed as it is when Brave lists it (`AR AU AT BE BR CA CL DK FI FR DE GR HK IN ID IT JP KR MY MX NL NZ NO CN PL PT PH RU SA ZA ES SE CH TW TR GB US`, `constants.ts`); any other country of the right form is searched without the filter |
| `language` | `search_lang` | passed as it is when Brave lists the code; `zh` goes as `zh-hans`, `pt` as `pt-pt` and `no` as `nb`; any other code is searched without the filter |
| `page` | `offset` | Brave's offset counts pages of `count` results from 0 (it allows 0 to 9), so `page 2` is `offset=1`; page 1 sends no `offset`, the request of today |

The lists and the offset were read on 2026-11-19 in Brave's web search API reference.

## Network

- One fixed host, `api.search.brave.com`, over https (`constants.ts`). A test hands its loopback server to `braveWebSearch()`; `create()` never takes another host.
- A 10-second timeout, the answer's read included. A redirect is never followed (`redirect: "manual"`), so the key never follows one to another host.
- An answer is read up to 1 MiB; a longer one is refused unparsed.
- No retry: the caller's activity retries by the code's kind.
- Nothing here logs, and the call opens no span (the platform keeps undici's instrumentation off). An error carries a status, Brave's short error code (`QUOTA_LIMITED`) or a reason, never the body, the query, the URL or the key, and never a cause.

## Mapping

| Brave answers | The port answers |
|---|---|
| 2xx, `web.results[]` | each result with an https `url` of at most 2,048 characters, in Brave's order, the first `count` |
| a result's `title`, `description` | `title`, `snippet`: the markup (`<strong>`) dropped, `&amp;` and the other entities decoded once, spaces folded, cut to 300 characters; none gives `""` |
| a result over http, without a `url`, or with a `url` that is no URL | left out |
| a result off the `site`, when the search names one | left out, though `site:` already keeps them off |
| 2xx without `web`, or `web: null` | `{ results: [] }` |
| 2xx, not JSON, or not an object | `web_search_provider_error`, `{ status, reason: "not JSON" }` or `reason: "an answer off the documented shape"` |

## Errors

| Brave answers | The port's code, `details` |
|---|---|
| 429, `error.code` `QUOTA_LIMITED` | `web_search_allowance_spent`, `{ status: 429, code }` |
| 402 | `web_search_allowance_spent`, `{ status: 402 }` |
| 401, 403 | `web_search_unauthorized`, `{ status }` |
| 422, `error.code` `SUBSCRIPTION_TOKEN_INVALID` (Brave's answer to a refused key) | `web_search_unauthorized`, `{ status: 422, code }` |
| 429 otherwise | `web_search_rate_limited`, `{ retryAfterSec }`: `Retry-After` in seconds or as a date, else the first window of `X-RateLimit-Reset`, else 1 |
| a redirect, 3xx | `web_search_provider_error`, `{ status, reason: "redirect" }`, its `Location` never read |
| an answer over 1 MiB | `web_search_provider_error`, `{ status, reason: "answer_too_large" }` |
| any other status | `web_search_provider_error`, `{ status, code? }`, `code` Brave's `error.code` when it is one short upper-case word |
| no answer in 10 seconds | `web_search_provider_error`, `{ reason: "timeout" }` |
| no answer at all | `web_search_provider_error`, `{ reason: "unreachable", code? }`, the network error's short code (`ECONNREFUSED`) |

## Vendor and terms

The Brave Search API, on the owner's account. Its free monthly credit covers about 1,000 searches; a card is needed to open the account. Brave bills only successful searches. The owner sets a spending limit at Brave, so the account never bills past the credit; then a search past it is Brave's quota error, `web_search_allowance_spent`. Enrichment keeps only the website and the LinkedIn page it chose from a search, never the result list; whether that fits Brave's terms on keeping results is the owner's check (the task's Open questions). The data processing agreement and the processing location go on the subprocessor page (RB-7.3.1).

**What the owner sets up:** the account with the monthly credit; the spending limit; the key, in `BRAVE_API_KEY` on the server; and, for the live check, a query they may run.

## Variables

| Variable | Holds |
|---|---|
| `BRAVE_API_KEY` | the key, a secret; `requires` names it, so the contract suite skips without it, and `create()` refuses an empty one (`config_invalid`) |
| `BRAVE_ALLOWANCE` | the free searches, `1000/month` in both examples; empty, no limit; a value off `<count>/day` or `<count>/month` fails at start |
| `BRAVE_TEST_QUERY` | the live check's one query, the owner's, set in their shell for that run only, never on a server |

## Provider refs

None: a search keeps nothing of Brave's.

## Known differences

- Brave takes up to 20 results and a query of up to 400 characters and 50 words; the port asks for 10 at most and 200 characters, and a query with its `site:` past Brave's limits is Brave's 422, `web_search_provider_error`.
- Brave's answer holds more than web results (news, videos, a query's spelling); the adapter reads `web.results` only.

## The live check

`tests/contract.test.ts` runs the port's live world: one search of `BRAVE_TEST_QUERY`, 3 results asked for, every other case skipped. It runs only when `BRAVE_TEST_QUERY` and `BRAVE_API_KEY` are both set in the environment, and refuses to start under `APP_ENV=production`:

```sh
BRAVE_API_KEY=… BRAVE_TEST_QUERY="Example Ltd official website" APP_ENV=test \
  node --test core/packages/providers/web-search/brave/tests/contract.test.ts
```

## Tests

`tests/mapping.test.ts`, offline: `braveWebSearch()` against a server of its own on 127.0.0.1, serving the synthetic answers of `tests/fixtures/` (shaped like Brave's documentation, never recorded). The port's contract suite on that server; the request made, the query, the count and the key header and nothing else; the country, the language and the page in Brave's own parameters, and a country or a language Brave has no filter for searched without it; the mapping table and the error table above, row by row, one request each; the timeout and an unreachable host; no key, query, site or body in an error, a log line, the console or a metric label; the live check's gate and `BRAVE_ALLOWANCE`, in child processes with no key.
