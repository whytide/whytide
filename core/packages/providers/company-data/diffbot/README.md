# diffbot: the company-data adapter on Diffbot's Knowledge Graph

**Covers.** `lookupCompany` of the [company-data port](../README.md), with one call: `GET https://kg.diffbot.com/kg/v3/enhance`, Enhance for an Organization. It sends one company key, whichever the input has first: the LinkedIn page, then the domain, both as `url`, then the name as `name`; never `countryHint`, never anything about a person. With it go `type=Organization`, `threshold=0.5` (`MIN_SCORE`) and the token. Node's `fetch`, in this folder only, to Diffbot's fixed host; no SDK, so no entry in `tools/lint/vendor-sdks.json`. A 10-second timeout, `redirect: "manual"` (a 3xx is never followed), an answer read up to 4 MiB and refused past it, no retry (enrichment retries by the code). The shared `../answer.ts` reads the answer and `../normalize.ts` puts its values in the port's forms.

**The match.** Diffbot answers its best match with a `score` from 0 to 1. A match is used only at `MIN_SCORE`, 0.5, or above: the call's `threshold` asks Diffbot for no weaker one, and the adapter checks the score again. Diffbot's own default (about 0.3) errs on the side of recall; a wrong company's size is worse than none. No match, or a weaker one, is `not_found`.

## Mapping

| Diffbot's Organization | `CompanyFacts` |
|---|---|
| `industries`, the first | `industry`, at most 200 characters |
| `nbEmployees` | `employeeCount` |
| `nbEmployeesMin`, `nbEmployeesMax`, without `nbEmployees` | `employeeRange`: `{ from, to }`; the lower bound alone `{ from }`; bounds that disagree, none |
| `homepageUri` (`www.example.com`) | `domain`, lower case, without `www.` |
| `linkedInUri` (`linkedin.com/company/example`) | `linkedinUrl`, `https://www.linkedin.com/company/<slug>`; any other LinkedIn page, none |
| `location.country.name` (`United States of America`) | `country`, its ISO 3166-1 alpha-2 code; a name it cannot tell, none |
| `foundingDate.str` (`d2008-XX-XX`) | `foundedYear` |
| `description` | `description`, cut at 2,000 characters |

A value off the port's form is left out, never the whole answer; a match with nothing the port takes is `not_found`. Nothing else of the entity is read: its people (`ceo`, `founders`), its names, its other locations. The adapter does not map `name`.

| Diffbot's answer | The port |
|---|---|
| 2xx, a match at `MIN_SCORE` or above | `found` |
| 2xx, no match, or a weaker one | `not_found` |
| 2xx that is not JSON | `company_data_provider_error`, `status`, `reason: "not_json"` |
| 2xx without its `data` list, or a match without its entity | `company_data_provider_error`, `reason: "off_shape"` |
| 401, 403 | `company_data_unauthorized` |
| 402; a 429 whose message names the quota or the credits ("429 Quota Exceeded") | `company_data_allowance_spent` |
| any other 429 | `company_data_rate_limited`, `retryAfterSec` from `Retry-After`, in seconds or as a date, at least 1; else 60 |
| a redirect; an answer past 4 MiB | `company_data_provider_error`, `status`, `reason: "redirect"`, `"answer_too_large"` |
| any other status | `company_data_provider_error`, `status` |
| no answer in 10 s; a network error | `company_data_provider_error`, `reason: "timeout"`; `"network"` with the error's short code |

## Vendor and terms

- **The free plan** (Diffbot's pricing and credits pages, read 2026-11-13): 10,000 credits a month, renewed monthly, not carried over; Enhance costs 25 credits a matched company and nothing for no match, so about 400 companies a month; 5 calls a minute on every API. Past the credits, the free plan answers 429.
- **The token.** Diffbot takes it in the query string only (its authentication page): no header carries it. So the request's URL is a secret: it goes to `fetch` and nowhere else. No error, detail or log line holds the URL, its query, a redirect's `Location` or the answer's body, the adapter opens no span, and the platform's telemetry leaves `fetch` uninstrumented and takes the query off every span's URL. `tests/mapping.test.ts` checks the token and the inputs in every error, log line, console line and metric label of a run.
- **Use in a product, caching, processing location, data processing agreement:** the owner's to confirm (the task's Open questions); Diffbot is a US company, and its terms of use and data processing terms are on its site. The adapter is merged without a token: `deploy/.env.production.example` lists it in `PROVIDER_COMPANY_DATA` after the open-data adapters and `google-kg`, and a host without `DIFFBOT_TOKEN` drops it from the list, or fails at start.

## Variables

In `deploy/.env.example` and `deploy/.env.production.example`, read when the adapter loads:

| Variable | |
|---|---|
| `DIFFBOT_TOKEN` (secret; `requires` names it) | the account's API token; `create()` fails with `config_invalid` while it is empty |
| `DIFFBOT_ALLOWANCE` | the calls per period enrichment allows, `<count>/day` or `<count>/month`; empty, the free plan's `400/month`. A paid plan raises it |
| `DIFFBOT_TEST_LINKEDIN_URL`, `DIFFBOT_TEST_DOMAIN`, `DIFFBOT_TEST_NAME` | the owner's, for the live case only, in the environment: one company the owner may look up |

What the owner sets up: a free account at diffbot.com and its token in `DIFFBOT_TOKEN`.

**Provider refs.** None: the adapter stores nothing; Diffbot's entity id is not kept.

**Known differences.** Diffbot's industries are its own labels (`Software Companies`), not LinkedIn's. It has no field for a range, only bounds. A LinkedIn page and a domain both go as `url`, Diffbot's "origin or homepage URI".

## Tests

No test reaches Diffbot. `tests/mapping.test.ts` runs the port's contract suite and every row above against a vendor on 127.0.0.1 (`../tests/fixtures/vendor.ts`) answering the synthetic fixtures of `tests/fixtures/` (shaped like Diffbot's documentation, never recorded): the request's query, exactly the one key, the type, the threshold and the token; a match, no match, a weak match, a range without a count, a country given by name, values off form, the quota answer, the rate limit, a 403, a 500, a redirect never followed, an answer past 4 MiB, the 10-second timeout (`../tests/fixtures/vendor.ts`'s `checkPattern`) and a refused connection; nothing of the token or the inputs left behind; and, in a child process, the allowance's default and `DIFFBOT_TOKEN` required at start. `tests/contract.test.ts` is the live suite: one lookup of the company `DIFFBOT_TEST_LINKEDIN_URL`, `DIFFBOT_TEST_DOMAIN` or `DIFFBOT_TEST_NAME` names, with `DIFFBOT_TOKEN`, both in the environment (`.env.local` is not read); skipped without them, refused under `APP_ENV=production`.
