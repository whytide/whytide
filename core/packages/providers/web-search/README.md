# The web-search port

A few web results for a query, in our words ([architecture §9](../../../../docs/architecture.md#9-ports-and-adapters)). One method, `searchWeb`. Enrichment uses it to find the website and the LinkedIn page of a company known only by its name (gamma-en-070). `PROVIDER_WEB_SEARCH` (`config.ts`) lists the adapters, in the order the caller asks them; each declares its free allowance ([../README.md](../README.md) "Many adapters per port"). Counting the searches, what to search for and which result to keep are the caller's, not the port's.

```ts
import { getAdapters, webSearchConfig, webSearchPort } from "@whytide/providers";

const searches = await getAdapters(webSearchPort, webSearchConfig.PROVIDER_WEB_SEARCH); // at start
for (const search of searches) {
  const { results } = await search.searchWeb({ query: "Example Ltd", site: "linkedin.com", count: 5 });
  // search.allowance: { calls, per } or null
}
```

## The method

| Method | Takes | Gives |
|---|---|---|
| `searchWeb` | `WebSearch`: `query`, `site?`, `count`, `country?`, `language?`, `page?`; nothing else | `{ results: WebResult[] }`, at most `count`, none when nothing matches |

| Key | Shape |
|---|---|
| `query` | 1 to 200 characters, not blank |
| `site` | a host name, lower case, two labels or more, at most 253 characters, no scheme, no path: the results stay on it and its subdomains |
| `count` | an integer, 1 to 10 |
| `country` | optional: an ISO 3166-1 alpha-2 code, two capital letters (`GB`); checked by form only |
| `language` | optional: an ISO 639-1 code, two lower-case letters (`de`); checked by form only |
| `page` | optional: an integer, 1 to 5 (`PAGE_MAX`), 1 when absent: the results after the first `count × (page − 1)` |

The port checks the form of `country` and `language`, never a list: it cannot know every vendor's. An adapter passes on what its vendor supports and searches without the filter for a country or a language it has no filter for; it never refuses one of the right form. The output does not change.

The input is a strict object: any other key, a person's included, is `web_search_input_invalid` before any call.

`WebResult` is a strict object: `url`, an https URL of at most 2,048 characters; `title` and `snippet`, plain text of at most 300 characters each, empty when the vendor gives none. The outputs are checked in every environment, production included (`alwaysCheckOutputs`): an answer off these shapes is `web_search_output_invalid`.

A query holds a company's name and words such as "official website", never a person's name (RB-7.3.1). The port cannot tell a company from a person, so this rule is the caller's (gamma-en-070). **Since 2026-11-19 (gamma-wr-070), one caller may:** by the owner's exception of 2026-11-16, signals' people step asks one search for a picked person's LinkedIn profile whose query holds the person's name and the company's name and nothing else about the person, on `site: "linkedin.com"`; every other caller, the web research run's plan, the search for a company's website and the search for a company's managers included, still holds none. The schema does not change: the query is text.

## Codes

| Code | When |
|---|---|
| `web_search_rate_limited` (429) | the vendor's rate limit; `details.retryAfterSec` is the wait in seconds |
| `web_search_allowance_spent` (402) | the vendor's free searches or credits are gone: its 402, or its own quota error; never retried |
| `web_search_unauthorized` (401) | the vendor refused the key |
| `web_search_provider_error` (502) | anything else the vendor answered, `details.status`, never its body; or no answer, `details.reason` |
| `web_search_input_invalid`, `web_search_output_invalid`, `web_search_error_unmapped` | the pattern's own ([../README.md](../README.md) "The boundary") |

Developer-facing: no message keys. No adapter retries: the caller's activity retries by the code's kind (gamma-p0-080).

## What the port will never have

A person's field in the input or the output, a page's content, a result's rank, image or thumbnail. The port logs nothing and opens no span; no query or site reaches an error, a log line or a metric label (`tests/contract.test.ts`). An adapter's own HTTP call opens none either: Node's fetch is undici, whose instrumentation the platform's telemetry keeps off.

## Adapters

| `PROVIDER_WEB_SEARCH` | `<ADAPTER>_ALLOWANCE` | Vendor |
|---|---|---|
| `brave` | `BRAVE_ALLOWANCE`, `1000/month` | the Brave Search API, its web search ([brave/README.md](brave/README.md)) |

`deploy/.env.example` lists the fake; `deploy/.env.production.example` lists `brave`. Without a Brave key, the list is left empty on a server, which loads no adapter, and deploy:check takes it.

## The fake

Results in memory, each list under a query, in any case. A search answers copies of the query's results: on its site only when it names one (the host or a subdomain of it), the `count` of the page asked, page 1 when none (page 2 is the results after the first `count`); an unseeded query answers none. The country and the language filter nothing: `recordedCalls` holds each call's `country`, `language` and `page`, for tests. Module tests reach it as `(await getAdapter(webSearchPort, "fake")) as unknown as WebSearchFake`. Its `create()` refuses `APP_ENV=production` with `adapter_invalid`: the fake never stands in for a vendor on a server. Its controls, beside `recordedCalls`, `answerNext` and `reset()`:

| Control | Does |
|---|---|
| `seedResults(query, results)` | the results a search of `query`, in any case, answers, in this order |
| `setAllowance(allowance)` | the allowance the bound fake exposes, `{ calls, per }` or null, until the next `reset()` |
| `failNext(code, details?)` | the next call throws the code; `web_search_rate_limited` carries `retryAfterSec: 60` and `web_search_provider_error` `status: 500`, unless `details` give them |

## The contract suite

`contract.ts` holds `webSearchCases(world)`: the results of the search the world names, in the port's words; the first `count` of them; a search with a country, a language and page 2, answered with results that are not page 1's; those on a site only; none for a search nothing matches; a search off its form (a country of three letters or in lower case, a language of three letters, page 0, a page past the most, a page in text included), and any key but the six (`offset` stays refused), refused before any call, `web_search_input_invalid`, with nothing recorded; each of the port's four codes from the vendor's next answer, the call after it answering again. An offline world, the fake or an adapter's answers served on 127.0.0.1, gets every case through its hooks `search()`, `onSite()`, `further()`, `nothing()`, `failNext(code)` and `calls()`.

**A live world, the vendor's API with the owner's key, gets exactly one search**, of the one query the world names, and every other case skips (`offline only: a live run makes one search`): a free plan's searches are few. The live suite refuses to start under `APP_ENV=production`. `tests/fixtures/live-world.ts` holds the rule on a stand-in adapter, never a vendor.

The suite runs on the fake from `fake/tests/contract.test.ts` and, taken from the registry through `PROVIDER_WEB_SEARCH`, from `tests/contract.test.ts` (`pnpm -F providers test:contract`), which also holds the port's own tests: the list at start, the codes, the output check, nothing logged. Brave's runs offline in `brave/tests/mapping.test.ts`. A new method: its schemas in `port.ts`, its case in `contract.ts`, then the fake and every adapter.
