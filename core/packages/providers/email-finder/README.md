# The email-finder port

A person's work address from their name and their company's domain, in our words ([architecture §9](../../../../docs/architecture.md#9-ports-and-adapters)). One method, `findEmail`. Its input is the first name, the last name and the company domain and nothing else, so no title, profile, id or other detail of the person reaches a finder (RB-7.3.1). `PROVIDER_EMAIL_FINDER` (`config.ts`) lists the adapters, in the order enrichment asks them; each declares its free allowance ([../README.md](../README.md) "Many adapters per port"). The lookup, the order across sources, counting the calls, the cache, the credits and what a vendor's verdict means are enrichment's (gamma-en-080), not the port's.

```ts
import { emailFinderConfig, emailFinderPort, getAdapters } from "@whytide/providers";

const finders = await getAdapters(emailFinderPort, emailFinderConfig.PROVIDER_EMAIL_FINDER); // at start
const answer = await finders[0].findEmail({ firstName: "Ada", lastName: "Lovelace", companyDomain: "example.com" });
// finders[0].allowance: { calls, per } or null
```

| Method | Takes | Gives |
|---|---|---|
| `findEmail` | `{ firstName, lastName, companyDomain }`, nothing else | `{ result: "found", address, vendorVerdict? }` or `{ result: "not_found" }` |

| Field | Shape |
|---|---|
| `firstName`, `lastName` | 1 to 100 characters, not blank |
| `companyDomain` | a host name, lower case, without `www.`, at most 253 characters, as the company-data port's `domain` |
| `address` | an address, lower case, at most 254 characters, the email-verifier port's form; at any domain: one off the company's is enrichment's to drop |
| `vendorVerdict` | the vendor's own check of the address, one of the five verdicts of the email-verifier port, `valid`, `catch_all`, `risky`, `invalid`, `unknown`; present only when the vendor checked the address itself |

The input is a strict object: any other key, an empty or blank name, or a domain that is not a host name is `finder_input_invalid` before any call. The outputs are checked in every environment, production included (`alwaysCheckOutputs`): an answer off these shapes is `finder_output_invalid`, a `vendorVerdict` outside the five or beside `not_found` among them. A vendor's accept-all is `catch_all`, never `valid`.

## Codes

| Code | When |
|---|---|
| `finder_rate_limited` (429) | the vendor's rate limit; `details.retryAfterSec` is the wait in seconds |
| `finder_allowance_spent` (402) | the vendor's free searches or credits are gone: its 402, or its own "quota used"; never retried |
| `finder_unauthorized` (401) | the vendor refused the key |
| `finder_provider_error` (502) | anything else the vendor answered: `details.status`, never its body |
| `finder_input_invalid`, `finder_output_invalid`, `finder_error_unmapped` | the pattern's own ([../README.md](../README.md) "The boundary") |

Developer-facing: no message keys.

## What the port will never have

Anything about the person beside the two names and the company's domain: a title, a LinkedIn profile, an id, a company's name, a phone. A search of every address at a domain, which would bring other people's addresses. The input's strict shape refuses an extra key before any call, and the output's refuses a field it does not declare, the vendor's sources and scores included. The port logs nothing and opens no span; no name, domain or address reaches an error, a log line or a metric label (`tests/contract.test.ts`).

## Adapters

| `PROVIDER_EMAIL_FINDER` | `<ADAPTER>_ALLOWANCE` | Vendor |
|---|---|---|
| [`hunter`](hunter/README.md) | `HUNTER_ALLOWANCE`, `50/month` | Hunter's Email Finder; `HUNTER_API_KEY` |
| [`tomba`](tomba/README.md) | `TOMBA_ALLOWANCE`, `25/month` | Tomba's Email Finder; `TOMBA_KEY`, `TOMBA_SECRET` |
| [`prospeo`](prospeo/README.md) | `PROSPEO_ALLOWANCE`, `75/month` | Prospeo's Enrich Person, verified addresses only; `PROSPEO_API_KEY` |
| [`snov`](snov/README.md) | `SNOV_ALLOWANCE`, `50/month` | Snov.io's Email Finder by name and domain, a task read within 10 seconds; `SNOV_CLIENT_ID`, `SNOV_CLIENT_SECRET` |

The allowances are the free plans' on 2026-11-13 (gamma-en-090); a paid plan changes the setting, not the code. `deploy/.env.example` lists the fake; `deploy/.env.production.example` names the four, `hunter,tomba,prospeo,snov`: drop one whose key you lack. An empty list loads no adapter: enrichment's other sources run without a finder. Each adapter reads its vendor's answer through `answer.ts` (a redirect never followed, a bounded read, the port's codes with the status and never the body) and maps it in its README's table; no adapter retries: on any error enrichment asks the next finder. Their mapping tests share `tests/fixtures/vendor.ts` and their live suites `tests/fixtures/live.ts`, one lookup of the person `<PREFIX>_TEST_FIRST_NAME`, `_LAST_NAME` and `_DOMAIN` name.

## The fake

It finds `<first>.<last>@<companyDomain>` for every person: each name lower case, its accents and marks dropped and anything but `a` to `z` and digits left out (`José` and `O'Brien-Smith` at `example.com` is `jose.obriensmith@example.com`); a name that keeps nothing, `李` for one, is `not_found`. Module tests reach it as `(await getAdapter(emailFinderPort, "fake")) as unknown as EmailFinderFake`. Its `create()` refuses `APP_ENV=production` with `adapter_invalid`: the fake never stands in for a vendor on a server. Its controls, beside `recordedCalls`, `answerNext` and `reset()`:

| Control | Does |
|---|---|
| `notFoundFor(firstName, lastName, companyDomain)` | the person, in any case, is `not_found` until the next `reset()` |
| `vendorVerdictFor(firstName, lastName, companyDomain, verdict)` | the person's address comes with `vendorVerdict: verdict`, any of the five, until the next `reset()`; for one person the last of the two helpers set wins |
| `setAllowance(allowance)` | the allowance the bound fake exposes, `{ calls, per }` or null, until the next `reset()`, so that enrichment's tests count against one |
| `failNext(code, details?)` | the next call throws the code; `finder_rate_limited` carries `retryAfterSec: 60` and `finder_provider_error` `status: 500`, unless `details` give them |

## The contract suite

`contract.ts` holds `emailFinderCases(world)`: the person the world names found, in the port's words, without a check of the vendor's; one whose address the vendor checked, with `vendorVerdict`; an unknown one `not_found`; any key beside the three, an empty name and a domain that is not a host name refused before any call, `finder_input_invalid`, with nothing recorded; each of the port's four codes from the vendor's next answer, the call after it finding the person again. An offline world, the fake or an adapter's recorded answers, gets every case through its hooks `person()`, `checked()`, `unknown()`, `failNext(code)` and `calls()`.

**A live world, the vendor's API with the owner's key, gets exactly one lookup**, of the one person the world names, a name and a company domain the owner may look up, and every other case skips (`offline only: a live run makes one lookup`): a free plan's searches are few. The live suite refuses to start under `APP_ENV=production`. `tests/fixtures/live-world.ts` holds the rule on a stand-in adapter, never a vendor.

The suite runs on the fake from `fake/tests/contract.test.ts` and, taken from the registry through `PROVIDER_EMAIL_FINDER`, from `tests/contract.test.ts` (`pnpm -F providers test:contract`), which also holds the port's own tests: the codes, the output check, nothing logged. A new method: its schemas in `port.ts`, its case in `contract.ts`, then the fake and every adapter.
