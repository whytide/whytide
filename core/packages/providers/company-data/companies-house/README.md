# companies-house: the company-data adapter

**Covers.** `lookupCompany` of the [company-data port](../README.md), on the Companies House public data API: a UK company's industry, by its first SIC code, and its country. Open data: `openData` is true, so enrichment shows its facts as the class `open_data`. `PROVIDER_COMPANY_DATA` names it `companies-house`.

## Calls

Node's `fetch` from this folder only (`client.ts`), on one fixed host, with no SDK, so no entry in `tools/lint/vendor-sdks.json`:

| Call | For |
|---|---|
| `GET https://api.company-information.service.gov.uk/search/companies?q=<name>&items_per_page=20` | the companies on the register by that name, their numbers and statuses |
| `GET https://api.company-information.service.gov.uk/company/<number>` | the one match's profile: its status and its SIC codes |

The key travels as HTTP basic's user, with an empty password, in the `Authorization` header, never in the URL. The adapter runs only for a `countryHint` of `GB` or a `domain` under `.uk`, and only with a name: any other lookup is `not_found` with no call. The search carries the name and nothing else of the input; the profile, the register's own number. Each request gives up after 10 seconds (`TIMEOUT_MS`), never follows a redirect (`redirect: "manual"`), and reads at most 256 KiB of the answer (`MAX_ANSWER_BYTES`). Nothing retries here: enrichment decides.

## The match rule

Of the search's first 20 results, the adapter keeps those whose status is `active`, whose number has the register's form (eight letters and digits), and whose `title` is the input's name once both are normalized ([../normalize.ts](../normalize.ts): case, accents, punctuation and legal suffixes, so "COPPER HARBOR LABS LIMITED" is "Copper Harbor Labs"). One number is the company. None, or two, is `not_found`: no guessing, and the search's ranking is not read. A profile whose status is no longer `active` is `not_found` too.

## Mapping

| Companies House | `CompanyFacts` field | Rule |
|---|---|---|
| the profile's first `sic_codes` entry | `industry` | its description in the SIC 2007 condensed list (`sic-2007.ts`); a code off the list, none |
| the register itself | `country` | `GB` |

Nothing else of the answers is read: no address, officer or filing.

## Errors

| Companies House answers | Port |
|---|---|
| 429 (its limit: 600 requests in 5 minutes) | `company_data_rate_limited`, `retryAfterSec` from `Retry-After` (seconds or a date), else 300 |
| 401 or 403 (the key wrong, or not a REST key) | `company_data_unauthorized`, with the status |
| 402 (never sent: the API is free) | `company_data_allowance_spent` |
| a redirect, an answer past 256 KiB, an answer off its documented shape, no answer in 10 s, a network error, any other status (a profile's 404 among them) | `company_data_provider_error`: `status` and `reason`, never the body |

No error, log line or span holds the key or an input's value: the adapter logs nothing and opens no span.

## Licence

The register's data is Crown copyright, under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). Its attribution, wherever the facts are shown with their source: "Contains public sector information licensed under the Open Government Licence v3.0." The lead page shows the source class `open_data`, never the vendor's name. `sic-2007.ts` is GOV.UK's [SIC 2007 condensed list](https://www.gov.uk/government/publications/standard-industrial-classification-of-economic-activities-sic) (`SIC07_CH_condensed_list_en.csv`, 731 codes, read on 2026-11-13), under the same licence: data, replaced whole when the list changes, never edited by hand.

## Variables

In `deploy/.env.example` and `deploy/.env.production.example`, the providers block. What the owner sets up: a Companies House developer account and a REST API key for the live service.

| Variable | |
|---|---|
| `COMPANIES_HOUSE_API_KEY` (secret; `requires` names it) | the REST key; required, or the adapter fails at start with `config_invalid` |
| `COMPANIES_HOUSE_ALLOWANCE` | empty: the API is free, with a rate limit but no allowance to count |
| `COMPANIES_HOUSE_TEST_NAME` | the owner's, for the live case only: one UK company the owner may look up |

**Provider refs.** None: the adapter stores nothing.

## Tests

No test reaches Companies House. `tests/mapping.test.ts` serves the register's answers on 127.0.0.1 (`tests/world.ts`, synthetic, in the API's documented shapes): the port's contract suite; every row of the table above from the one active company whose name matches, beside a dissolved one of the same name, the requests read back; no call without a GB hint or a `.uk` domain, or without a name; a dissolved company, two matches, none, a profile no longer active, and a SIC code off the list; the rate limit's default wait; a redirect, an answer past 256 KiB and no answer in 10 s; no key in a URL, no key or input in an error or a log line; the adapter as a host starts it. `tests/contract.test.ts` is the live suite: one lookup of the owner's company, with the hint `GB`, only with `COMPANIES_HOUSE_API_KEY` and `COMPANIES_HOUSE_TEST_NAME` set, never under `APP_ENV=production` ([../README.md](../README.md) "The contract suite").
