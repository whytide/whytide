# pdl: the company-data adapter on People Data Labs

**Covers.** `lookupCompany` of the [company-data port](../README.md), with one call: `GET https://api.peopledatalabs.com/v5/company/enrich`, Company Enrichment. It sends one company key, whichever the input has first: the LinkedIn page as `profile`, then the domain as `website`, then the name as `name`; never `countryHint`, never anything about a person. With it goes `min_likelihood`, from `PDL_MIN_LIKELIHOOD`. The key travels in the `X-Api-Key` header, never in the URL. Node's `fetch`, in this folder only, to PDL's fixed host; no SDK, so no entry in `tools/lint/vendor-sdks.json`. A 10-second timeout, `redirect: "manual"` (a 3xx is never followed, so the key never follows one), an answer read up to 1 MiB and refused past it, no retry (enrichment retries by the code). The shared `../answer.ts` reads the answer and `../normalize.ts` puts its values in the port's forms.

**The match.** PDL answers one record with its `likelihood`, 1 to 10, and a 404 below `min_likelihood`. `PDL_MIN_LIKELIHOOD` is 6 by default, PDL's advice for high accuracy (its own default is 2). A record below it that comes back anyway is `not_found` too.

## Mapping

| PDL's company record | `CompanyFacts` |
|---|---|
| `industry` (`computer software`) | `industry`, as given, at most 200 characters |
| `employee_count` | `employeeCount`, from 1 |
| `size` (`11-50`, `10001+`), without an `employee_count` | `employeeRange`: `{ from, to }`, the open band `{ from }`; a size off PDL's canonical list, none |
| `website` (`example.com`) | `domain`, lower case, without `www.` |
| `linkedin_url` (`linkedin.com/company/example`) | `linkedinUrl`, `https://www.linkedin.com/company/<slug>`; any other LinkedIn page, none |
| `location.country` (`united states`) | `country`, its ISO 3166-1 alpha-2 code: every name of PDL's canonical country list has one |
| `founded` | `foundedYear` |
| `summary` | `description`, cut at 2,000 characters (PDL's are at most 1,000) |

A value off the port's form is left out, never the whole answer; a record with nothing the port takes is `not_found`. Nothing else of the record is read: its address, its tags, its employee breakdowns. The adapter does not map `name`. PDL's values are lower case, as it sends them (`titlecase` is not asked for).

| PDL's answer | The port |
|---|---|
| 2xx, `likelihood` at `PDL_MIN_LIKELIHOOD` or above | `found` |
| 404 (`not_found`); 2xx below `PDL_MIN_LIKELIHOOD` | `not_found` |
| 2xx that is not JSON | `company_data_provider_error`, `status`, `reason: "not_json"` |
| 2xx that is JSON but not an object | `company_data_provider_error`, `reason: "off_shape"` |
| 401 (`authentication_error`), 403 | `company_data_unauthorized` |
| 402 (`payment_required`: the month's matches used) | `company_data_allowance_spent` |
| 429 (`rate_limit_error`) | `company_data_rate_limited`, `retryAfterSec` from `Retry-After`, in seconds or as a date, at least 1; else 60 |
| a redirect; an answer past 1 MiB | `company_data_provider_error`, `status`, `reason: "redirect"`, `"answer_too_large"` |
| 400, 405, 5xx, any other | `company_data_provider_error`, `status` |
| no answer in 10 s; a network error | `company_data_provider_error`, `reason: "timeout"`; `"network"` with the error's short code |

## Vendor and terms

- **The free plan** (PDL's documentation, read 2026-11-13): 100 company enrichment credits a month, charged per match (a 404 costs nothing), 10 calls a minute. Contact fields are not on the free plan, and the adapter reads none.
- **Use in a product, caching, processing location, data processing agreement:** the owner's to confirm (the task's Open questions); People Data Labs is a US company, and its terms of service and data processing addendum are on its site. The adapter is merged without a key: `deploy/.env.production.example` lists it last in `PROVIDER_COMPANY_DATA`, and a host without `PDL_API_KEY` drops it from the list, or fails at start.

## Variables

In `deploy/.env.example` and `deploy/.env.production.example`, read when the adapter loads:

| Variable | |
|---|---|
| `PDL_API_KEY` (secret; `requires` names it) | the account's API key; `create()` fails with `config_invalid` while it is empty |
| `PDL_ALLOWANCE` | the calls per period enrichment allows, `<count>/day` or `<count>/month`; empty, the free plan's `100/month`. A paid plan raises it |
| `PDL_MIN_LIKELIHOOD` | the least likelihood of a match, 1 to 10; empty, 6 |
| `PDL_TEST_LINKEDIN_URL`, `PDL_TEST_DOMAIN`, `PDL_TEST_NAME` | the owner's, for the live case only, in the environment: one company the owner may look up |

What the owner sets up: a free account at peopledatalabs.com and its key in `PDL_API_KEY`.

**Provider refs.** None: the adapter stores nothing; PDL's record id is not kept.

**Known differences.** PDL's industries are LinkedIn's, in lower case. A company's size is a canonical band when PDL has no count.

## Tests

No test reaches PDL. `tests/mapping.test.ts` runs the port's contract suite and every row above against a vendor on 127.0.0.1 (`../tests/fixtures/vendor.ts`) answering the synthetic fixtures of `tests/fixtures/` (shaped like PDL's documentation, never recorded): the request's query, exactly the one key and `min_likelihood`, and the key in `X-Api-Key` only; a match, no match, a weak match, a range without a count, a country given by name (and PDL's 249 canonical names, `tests/fixtures/countries.json`, each to a code of its own), values off form, the quota answer, the rate limit, a 403, a 400 and a 500, a redirect never followed, an answer past 1 MiB, the 10-second timeout (`../tests/fixtures/vendor.ts`'s `checkPattern`) and a refused connection; nothing of the key or the inputs left behind; and, in a child process, the allowance's and the likelihood's defaults and `PDL_API_KEY` required at start. `tests/contract.test.ts` is the live suite: one lookup of the company `PDL_TEST_LINKEDIN_URL`, `PDL_TEST_DOMAIN` or `PDL_TEST_NAME` names, with `PDL_API_KEY`, both in the environment (`.env.local` is not read); skipped without them, refused under `APP_ENV=production`.
