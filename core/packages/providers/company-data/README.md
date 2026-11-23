# The company-data port

A company's facts from its LinkedIn page, its domain or its name, in our words ([architecture §9](../../../../docs/architecture.md#9-ports-and-adapters)). One method, `lookupCompany`. Its input holds a company's keys and nothing else, so a person's name, title, email or address never reaches a company source (RB-7.3.1). `PROVIDER_COMPANY_DATA` (`config.ts`) lists the adapters, in the order enrichment asks them; each declares its free allowance and whether its data is open data ([../README.md](../README.md) "Many adapters per port"). Counting the calls, the order across sources and what a found fact does are enrichment's (gamma-en-050), not the port's.

```ts
import { companyDataConfig, companyDataPort, getAdapters } from "@whytide/providers";

const sources = await getAdapters(companyDataPort, companyDataConfig.PROVIDER_COMPANY_DATA); // at start
for (const source of sources) {
  const answer = await source.lookupCompany({ linkedinUrl: "https://www.linkedin.com/company/example" });
  // source.allowance: { calls, per } or null; source.openData: its facts show as open_data, else data_vendor
}
```

| Method | Takes | Gives |
|---|---|---|
| `lookupCompany` | `CompanyLookup`: at least one of `linkedinUrl`, `domain` and `name`; `countryHint?`; nothing else | `{ result: "found", company: CompanyFacts }` or `{ result: "not_found" }` |

The input is a strict object: any other key, a person's included, is `company_data_input_invalid` before any call.

| Key | Shape |
|---|---|
| `linkedinUrl` | `https://www.linkedin.com/company/<slug>`, in that one form: https, `www.`, no trailing slash, no query |
| `domain` | a host name, lower case, without `www.`, at most 253 characters |
| `name` | 1 to 200 characters, not blank |
| `countryHint` | ISO 3166-1 alpha-2, upper case; it narrows a name |

`CompanyFacts` is a strict object, each field optional, at least one besides `name`; an adapter leaves out what it does not know:

| Field | Shape |
|---|---|
| `name`, `domain`, `linkedinUrl` | as the input's |
| `industry` | text, 1 to 200 characters |
| `employeeCount` | an integer, at least 1 |
| `employeeRange` | `{ from, to? }`, integers, `to` at least `from`; no `to` for an open band, 10,001+ |
| `country` | ISO 3166-1 alpha-2 |
| `description` | text, 1 to 2,000 characters |
| `foundedYear` | an integer, 1 to 9999 |

The outputs are checked in every environment, production included (`alwaysCheckOutputs`): an answer off these shapes is `company_data_output_invalid`.

## Codes

| Code | When |
|---|---|
| `company_data_rate_limited` (429) | the vendor's rate limit; `details.retryAfterSec` is the wait in seconds |
| `company_data_allowance_spent` (402) | the vendor's free calls or credits are gone: its 402, or its own "quota used"; never retried |
| `company_data_unauthorized` (401) | the vendor refused the key |
| `company_data_provider_error` (502) | anything else the vendor answered: `details.status`, never its body |
| `company_data_input_invalid`, `company_data_output_invalid`, `company_data_error_unmapped` | the pattern's own ([../README.md](../README.md) "The boundary") |

Developer-facing: no message keys.

## What the port will never have

A person: a first or last name, a title, an email, a phone, an address, a member's profile. The input's strict shape refuses each before any call, and the output's refuses a field it does not declare, so nothing about a person comes back either. The port logs nothing and opens no span; no input's value reaches an error, a log line or a metric label (`tests/contract.test.ts`).

## Adapters

| `PROVIDER_COMPANY_DATA` | `<ADAPTER>_ALLOWANCE` | `openData` | Vendor |
|---|---|---|---|
| [`companies-house`](companies-house/README.md) | empty | true | Companies House, UK companies only |
| [`diffbot`](diffbot/README.md) | `400/month` | false | Diffbot's Knowledge Graph, Enhance, free plan |
| [`google-kg`](google-kg/README.md) | `100000/day` | false | Google Knowledge Graph |
| [`pdl`](pdl/README.md) | `100/month` | false | People Data Labs' Company Enrichment, free plan |
| [`wikidata`](wikidata/README.md) | empty | true | Wikidata |

Each adapter's README has its calls, its match rule, its mapping table, its licence or terms and what the owner sets up. `deploy/.env.example` lists the fake (below); `deploy/.env.production.example` lists the adapters in the order enrichment asks them, each of which fails at start without its key or contact.

What the adapters share: `normalize.ts`, one way to read a name (case, accents, punctuation and legal suffixes), so that an adapter answers only for the one company whose name is the input's, and a vendor's values in the port's forms: a website's host (a bare one, `example.com`, where the adapter allows it), a LinkedIn link as the company page, a country's English name as its code, a text cut to the port's bound, a count; `answer.ts`, a vendor's answer read up to the adapter's bound and turned into the port's codes, never its body, the vendor's own reading of a failure first (Diffbot's quota 429, Google's daily quota) and its no-match status as none (People Data Labs' 404). `tests/fixtures/vendor.ts` serves a vendor's answers on 127.0.0.1 for each adapter's `mapping.test.ts`, with the pattern's redirect, bound and timeout checks and a port nothing listens on, and `tests/fixtures/live.ts` is each adapter's live suite: one lookup of the company the owner names in `<ADAPTER>_TEST_NAME`, `_TEST_DOMAIN` or `_TEST_LINKEDIN_URL`, skipped when none is set.

## The fake

Companies in memory, each under a key: its LinkedIn page, its domain or its name, in any case. A lookup tries the page, then the domain, then the name, and answers a copy of the first company found, or `not_found`; it does not read `countryHint`. Module tests reach it as `(await getAdapter(companyDataPort, "fake")) as unknown as CompanyDataFake`. Its `create()` refuses `APP_ENV=production` with `adapter_invalid`: the fake never stands in for a vendor on a server. Its data is not open data. Its controls, beside `recordedCalls`, `answerNext` and `reset()`:

| Control | Does |
|---|---|
| `seedCompany(key, facts)` | a company a lookup finds by `key`: a LinkedIn page, a domain or a name, in any case; anything unseeded is `not_found` |
| `setAllowance(allowance)` | the allowance the bound fake exposes, `{ calls, per }` or null, until the next `reset()`, so that enrichment's tests count against one |
| `failNext(code, details?)` | the next call throws the code; `company_data_rate_limited` carries `retryAfterSec: 60` and `company_data_provider_error` `status: 500`, unless `details` give them |

## The contract suite

`contract.ts` holds `companyDataCases(world)`: the company the world names found, with its facts in the port's words; an unknown one `not_found`; no company key, a person's key beside one, a link that is not a company page and a key off its form each refused before any call, `company_data_input_invalid`, with nothing recorded; each of the port's four codes from the vendor's next answer, the call after it finding the company again. An offline world, the fake or an adapter's recorded answers, gets every case through its hooks `company()`, `unknown()`, `failNext(code)` and `calls()`.

**A live world, the vendor's API with the owner's key, gets exactly one lookup**, of the one company the world names, and every other case skips (`offline only: a live run makes one lookup`): a free plan's calls are few. The live suite refuses to start under `APP_ENV=production`. `tests/fixtures/live-world.ts` holds the rule on a stand-in adapter, never a vendor.

The suite runs on the fake from `fake/tests/contract.test.ts` and, taken from the registry through `PROVIDER_COMPANY_DATA`, from `tests/contract.test.ts` (`pnpm -F providers test:contract`), which also holds the port's own tests: the list at start, the codes, the output check, nothing logged. A new method: its schemas in `port.ts`, its case in `contract.ts`, then the fake and every adapter.
