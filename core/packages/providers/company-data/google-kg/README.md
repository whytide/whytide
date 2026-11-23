# google-kg: the company-data adapter

**Covers.** `lookupCompany` of the [company-data port](../README.md), on Google's Knowledge Graph Search API: a company's official website and its description, found by its name. `openData` stays false: its facts show as a data vendor's, `data_vendor`. `PROVIDER_COMPANY_DATA` names it `google-kg`.

## Calls

Node's `fetch` from this folder only (`client.ts`), on one fixed host, with no SDK, so no entry in `tools/lint/vendor-sdks.json`:

| Call | For |
|---|---|
| `GET https://kgsearch.googleapis.com/v1/entities:search?query=<name>&types=Organization&limit=5` | the organizations Google knows by that name |

The key travels in the `X-Goog-Api-Key` header, never in the URL. The request carries the name and nothing else of the input: a lookup without a name is `not_found` with no call, and `domain`, `linkedinUrl` and `countryHint` are never sent. It gives up after 10 seconds (`TIMEOUT_MS`), never follows a redirect (`redirect: "manual"`), and reads at most 256 KiB of the answer (`MAX_ANSWER_BYTES`). Nothing retries here: enrichment decides.

## The match rule

Of the organizations Google answers, the adapter keeps those whose `name` is the input's once both are normalized ([../normalize.ts](../normalize.ts): case, accents, punctuation and legal suffixes, so "Copper Harbor Labs, Inc." is "Copper Harbor Labs"). One is the company. None, or two, is `not_found`: no guessing, and Google's ranking (`resultScore`) is not read.

## Mapping

| Knowledge Graph | `CompanyFacts` field | Rule |
|---|---|---|
| `url` | `domain` | the website's host, lower case, without `www.` |
| `detailedDescription.articleBody` | `description` | cut at 2,000 characters |

Nothing else of the answer is read. A match with neither is `not_found`.

## Errors

Google's answers follow its error model (`google.rpc.Status` with `ErrorInfo` details), or its older one (`errors[]`); the adapter reads their `reason` and `metadata.quota_limit`, and nothing else of the body.

| Google answers | Port |
|---|---|
| 403 or 429 for a daily quota (`quota_limit` holds `PerDay`, or the reason `dailyLimitExceeded`) | `company_data_allowance_spent`: the free 100,000 calls of the day are gone |
| 403 with the reason `rateLimitExceeded` or `userRateLimitExceeded`; any other 429 | `company_data_rate_limited`, `retryAfterSec` from `Retry-After`, else 60 |
| the reason `API_KEY_INVALID` or `keyInvalid`; 401; any other 403 (the API not enabled for the key, or the key restricted) | `company_data_unauthorized`, with the status |
| 402 | `company_data_allowance_spent` |
| a redirect, an answer past 256 KiB, an answer off its documented shape, no answer in 10 s, a network error, any other status | `company_data_provider_error`: `status` and `reason`, never the body |

The daily quota's name is not documented for this API; `PerDay` is how Google names its daily limits. The owner's live run is the first to meet a real 429. No error, log line or span holds the key or an input's value: the adapter logs nothing and opens no span.

## Licence

Google's [terms](https://developers.google.com/terms) cover the API's use, and the descriptions are often Wikipedia's text, CC BY-SA, whose page and licence the answer names (`detailedDescription.url`, `license`; not kept). Whether the website and description may be kept is the owner's to check (the task's Open questions): until then, the facts show as `data_vendor`, never as open data.

## Variables

In `deploy/.env.example` and `deploy/.env.production.example`, the providers block. What the owner sets up: a Google Cloud project with the Knowledge Graph Search API enabled, and an API key restricted to that API.

| Variable | |
|---|---|
| `GOOGLE_KG_API_KEY` (secret; `requires` names it) | the key; required, or the adapter fails at start with `config_invalid` |
| `GOOGLE_KG_ALLOWANCE` | the free calls: `100000/day`, also when empty |
| `GOOGLE_KG_TEST_NAME` | the owner's, for the live case only: one company the owner may look up |

**Provider refs.** None: the adapter stores nothing.

## Tests

No test reaches Google. `tests/mapping.test.ts` serves Google's answers on 127.0.0.1 (`tests/world.ts`, synthetic, in the API's documented shapes): the port's contract suite, its four codes from Google's own answers; every row of the table above from the one organization that matches, the request read back; a name that does not match, two that do, none, a match with no fact, and no name; Google's error model; a redirect, an answer past 256 KiB and no answer in 10 s; no key in a URL, no key or input in an error or a log line; the adapter as a host starts it. `tests/contract.test.ts` is the live suite: one lookup of the owner's company, only with `GOOGLE_KG_API_KEY` and `GOOGLE_KG_TEST_NAME` set, never under `APP_ENV=production` ([../README.md](../README.md) "The contract suite").
