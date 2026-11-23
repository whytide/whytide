# wikidata: the company-data adapter

**Covers.** `lookupCompany` of the [company-data port](../README.md), on Wikidata: a well-known company's website, LinkedIn page, industry, employee count, country, founding year and description. Open data, no key: `openData` is true, so enrichment shows its facts as the class `open_data`. `PROVIDER_COMPANY_DATA` names it `wikidata`.

## Calls

Node's `fetch` from this folder only (`client.ts`), on two fixed hosts, with no SDK, so no entry in `tools/lint/vendor-sdks.json`:

| Call | For |
|---|---|
| `POST https://query.wikidata.org/sparql`, a form with `query` | the items a key selects, at most two, and their facts, one row per value (`sparql.ts`) |
| `GET https://www.wikidata.org/w/api.php?action=wbsearchentities&search=<name>&language=en&uselang=en&type=item&limit=10&format=json` | the items whose English label or alias starts with the name |

Every request carries the User-Agent `Whytide-company-data/1.0 (<WIKIDATA_CONTACT>)`, as [Wikimedia's User-Agent policy](https://meta.wikimedia.org/wiki/User-Agent_policy) asks, and nothing else of ours. At most one request a second per process: a request starts a second after the last one started (`MIN_INTERVAL_MS`). Each gives up after 10 seconds (`TIMEOUT_MS`), never follows a redirect (`redirect: "manual"`), and reads at most 1 MiB of the answer (`MAX_ANSWER_BYTES`). Nothing retries here: enrichment decides. A query carries the company's keys only, each in a `VALUES` block after its form is checked: the page's slug, the website's forms, the search's item ids, the hint's country code. The name goes to the search only.

## The match rule

The item is found by the first of the input's keys that selects any item, in this order:

1. `linkedinUrl`: the items whose LinkedIn company ID (P4264) is the page's slug, as given or in lower case;
2. `domain`: the items whose official website (P856) is at the domain: `http` or `https`, with or without `www.`, with or without a trailing slash;
3. `name`: the search's items whose English label, or the alias it matched, is the name once both are normalized ([../normalize.ts](../normalize.ts): case, accents, punctuation and legal suffixes), kept when they are a business (P31, or a class above it through P279, is Q4830453) and, with `countryHint`, in that country (P17's P297).

One item is the company. Two items are `not_found`, and the keys after it are not tried: no guessing. A key that selects none hands on to the next; when none selects any, `not_found`. `countryHint` narrows the name only.

## Mapping

| Wikidata | `CompanyFacts` field | Rule |
|---|---|---|
| P856 | `domain` | the website's host, lower case, without `www.`; several hosts, none |
| P4264 | `linkedinUrl` | `https://www.linkedin.com/company/<P4264>` in the port's form; several, none |
| P452's English label | `industry` | the first: the industry item with the lowest number |
| P1128 | `employeeCount` | the one with the latest point in time (P585), deprecated ones left out; without any point in time, the one value if there is one |
| P17, then P297 | `country` | one code; several, none |
| P571's year | `foundedYear` | the earliest year of the common era |
| the English description | `description` | cut at 2,000 characters |

Best-ranked values (`wdt:`) everywhere but P1128. An item with none of these facts is `not_found`: a label alone is not a fact.

## Errors

| Wikidata answers | Port |
|---|---|
| 429 | `company_data_rate_limited`, `retryAfterSec` from `Retry-After` (seconds or a date), else 60 |
| 401 or 403 (the User-Agent refused) | `company_data_unauthorized`, with the status |
| 402 (never sent: Wikidata has no allowance) | `company_data_allowance_spent` |
| a redirect, an answer past 1 MiB, an answer off its documented shape, no answer in 10 s, a network error, any other status | `company_data_provider_error`: `status` and `reason` (`redirect`, `answer_too_large`, `off_shape`, `not_json`, `timeout`, `network` with its short code), never the body |

No error, log line or span holds an input's value or the contact: the adapter logs nothing and opens no span.

## Licence

Wikidata's data is [CC0](https://www.wikidata.org/wiki/Wikidata:Copyright): no attribution is required. The lead page shows the source class `open_data`, never the vendor's name.

## Variables

In `deploy/.env.example` and `deploy/.env.production.example`, the providers block. What the owner sets up: a contact, and nothing else.

| Variable | |
|---|---|
| `WIKIDATA_CONTACT` (`requires` names it) | an email address or an `https` page where Wikimedia can reach the operator; required, or the adapter fails at start with `config_invalid` |
| `WIKIDATA_ALLOWANCE` | empty: Wikidata has no free allowance to count |
| `WIKIDATA_TEST_NAME`, `WIKIDATA_TEST_DOMAIN`, `WIKIDATA_TEST_LINKEDIN_URL` | the owner's, for the live case only: one company the owner may look up |

**Provider refs.** None: the adapter stores nothing.

## Tests

No test reaches Wikidata. `tests/mapping.test.ts` serves Wikidata's answers on 127.0.0.1 (`tests/world.ts`, synthetic): the port's contract suite; every row of the table above from one item, by each key, the requests read back; none, two items and an item with no fact; the keys' order; two lookups a second apart through the process's gate; a redirect, an answer past 1 MiB and no answer in 10 s; no input or contact in an error or a log line; the adapter as a host starts it. `tests/contract.test.ts` is the live suite: one lookup of the owner's company, only with `WIKIDATA_CONTACT` and a `WIKIDATA_TEST_*` variable set, never under `APP_ENV=production` ([../README.md](../README.md) "The contract suite"). The queries have not met the real service yet: the owner's live run is their first.
