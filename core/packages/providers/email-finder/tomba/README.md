# tomba: the email-finder adapter on Tomba

**Covers.** `findEmail` of the [email-finder port](../README.md), with one call: `GET https://api.tomba.io/v1/email-finder`, Email Finder ([Tomba's API page](https://tomba.io/api), read 2026-11-13). It sends `domain`, `first_name` and `last_name`, and nothing else. The key and the secret travel in the `X-Tomba-Key` and `X-Tomba-Secret` headers, never in the URL. Node's `fetch`, in this folder only (`client.ts`), to Tomba's fixed host; no SDK. A 30-second timeout, `redirect: "manual"`, an answer read up to 256 KiB, no retry: on any error enrichment asks the next finder (gamma-en-080). The shared `../answer.ts` reads the answer. Never a domain search.

## Mapping

| Tomba's answer | The port |
|---|---|
| 2xx, `data.email` set | `found`, the address lower case, at any domain |
| `data.accept_all: true`, or `verification.status` `accept_all` | `vendorVerdict: "catch_all"`, never `valid` |
| `verification.status` `valid`, `invalid`, `unknown` | `vendorVerdict` the same |
| `verification.status` `webmail`, `disposable` | `vendorVerdict: "risky"` |
| `verification.status` null, or one not listed here | no `vendorVerdict` |
| 2xx, `data.email` null, or no `data` | `not_found` |
| 2xx with an address off the port's form; JSON off Tomba's shape | `finder_provider_error`, `reason: "off_shape"` |
| 2xx that is not JSON | `finder_provider_error`, `status`, `reason: "not_json"` |
| 429 | `finder_rate_limited`, `retryAfterSec` from `Retry-After`; else 60 |
| 402 | `finder_allowance_spent`, `status` |
| 401, 403 | `finder_unauthorized`, `status` |
| a redirect; an answer past 256 KiB | `finder_provider_error`, `status`, `reason: "redirect"`, `"answer_too_large"` |
| 400, 5xx, any other | `finder_provider_error`, `status` |
| no answer in 30 s; a network error | `finder_provider_error`, `reason: "timeout"`; `"network"` with the error's short code |

**The docs.** Tomba's page shows one found answer, `verification.status` `valid`, and documents no error status and no not-found answer: the error rows are the task's table, read by the status, and the verification statuses those of Hunter's shape, which Tomba's answer copies. The live check confirms them; where Tomba's answers differ, they win and this table changes.

## Vendor and terms

- **The free plan** (Tomba's API page, read 2026-11-13): 25 search credits every 30 days, no card; one credit per address returned with a status other than `unknown`. The free plan's rate limit is 1 call a second, 2 a minute and 5 a day on the finder's group of calls; the FAQ says 5 to 20 a day.
- **Processing location, data processing agreement, keeping results:** the owner's to confirm. The adapter keeps nothing.

## Variables

| Variable | |
|---|---|
| `TOMBA_KEY` (secret; `requires` names it) | the account's API key (`ta_…`) |
| `TOMBA_SECRET` (secret; `requires` names it) | the account's secret (`ts_…`); `create()` fails with `config_invalid` while either is empty |
| `TOMBA_ALLOWANCE` | `<count>/day` or `<count>/month`; empty, the free plan's `25/month` |
| `TOMBA_TEST_FIRST_NAME`, `TOMBA_TEST_LAST_NAME`, `TOMBA_TEST_DOMAIN` | the owner's, for the live case only, in the environment |

What the owner sets up: a free account at tomba.io, its key and secret.

## Tests

No test reaches Tomba. `tests/mapping.test.ts` runs the port's contract suite and every row above against a vendor on 127.0.0.1 answering the synthetic `tests/fixtures/found.json`: the request with the three parameters and the two headers only; each verdict; the statuses; the pattern; nothing of the key, the secret or the inputs left behind; the allowance's default and both variables required at start. `tests/contract.test.ts` is the live suite: one lookup of the person the three `TOMBA_TEST_*` variables name; skipped without them or the credentials, refused under `APP_ENV=production`.
