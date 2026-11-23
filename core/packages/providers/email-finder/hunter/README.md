# hunter: the email-finder adapter on Hunter

**Covers.** `findEmail` of the [email-finder port](../README.md), with one call: `GET https://api.hunter.io/v2/email-finder`, Email Finder ([Hunter's API documentation, v2](https://hunter.io/api-documentation/v2#email-finder), read 2026-11-13). It sends `domain`, `first_name` and `last_name`, and nothing else: never a full name, a company name or a LinkedIn handle. The key travels in the `X-API-KEY` header, never in the URL (Hunter also takes `api_key` there; never used). Node's `fetch`, in this folder only (`client.ts`), to Hunter's fixed host; no SDK, so no entry in `tools/lint/vendor-sdks.json`. A 30-second timeout (Hunter's own search runs up to 10 s), `redirect: "manual"`, an answer read up to 256 KiB, no retry: on any error enrichment asks the next finder (gamma-en-080). The shared `../answer.ts` reads the answer. Never a domain search: it would bring other people's addresses.

## Mapping

| Hunter's answer | The port |
|---|---|
| 2xx, `data.email` set | `found`, the address lower case, at any domain |
| `data.accept_all: true`, or `verification.status` `accept_all` | `vendorVerdict: "catch_all"`, never `valid` |
| `verification.status` `valid`, `invalid`, `unknown` | `vendorVerdict` the same |
| `verification.status` `webmail`, `disposable` | `vendorVerdict: "risky"` |
| `verification.status` null, or one Hunter does not document | no `vendorVerdict` |
| 2xx, `data.email` null, or no `data` | `not_found` (Hunter charges nothing) |
| 451 (`claimed_email`: the person asked Hunter not to process their data) | `not_found` |
| 2xx with an address off the port's form; JSON off Hunter's shape | `finder_provider_error`, `reason: "off_shape"` |
| 2xx that is not JSON | `finder_provider_error`, `status`, `reason: "not_json"` |
| 403 (Hunter's rate limit) | `finder_rate_limited`, `retryAfterSec` from `Retry-After`, in seconds or as a date; else 60 |
| 429 (Hunter's usage limit: the month's credits used), 402 | `finder_allowance_spent`, `status` |
| 401 | `finder_unauthorized` |
| a redirect; an answer past 256 KiB | `finder_provider_error`, `status`, `reason: "redirect"`, `"answer_too_large"` |
| 400, 404, 5xx, any other | `finder_provider_error`, `status` |
| no answer in 30 s; a network error | `finder_provider_error`, `reason: "timeout"`; `"network"` with the error's short code |

**The docs win.** gamma-en-090's table reads 429 as the rate limit and 403 as a refused key; Hunter's documentation says its 403 is the rate limit and its 429 the usage limit, so the adapter follows Hunter.

## Vendor and terms

- **The free plan** (Hunter's pricing, read 2026-11-13): 50 credits a month, shared with Hunter's own verifier, which the adapter never calls. A search that finds nothing is free, and so is a repeat within the month. Email Finder allows 15 calls a second and 500 a minute.
- **Processing location, data processing agreement, keeping results:** the owner's to confirm (the task's "What the owner gives"). Hunter is a French company; its terms and its data processing agreement are on its site. The adapter keeps nothing.

## Variables

In `deploy/.env.example` and `deploy/.env.production.example`, read when the adapter loads:

| Variable | |
|---|---|
| `HUNTER_API_KEY` (secret; `requires` names it) | the account's API key; `create()` fails with `config_invalid` while it is empty |
| `HUNTER_ALLOWANCE` | the calls per period enrichment allows, `<count>/day` or `<count>/month`; empty, the free plan's `50/month`. A paid plan raises it |
| `HUNTER_TEST_FIRST_NAME`, `HUNTER_TEST_LAST_NAME`, `HUNTER_TEST_DOMAIN` | the owner's, for the live case only, in the environment: one person the owner may look up |

What the owner sets up: a free account at hunter.io and its key in `HUNTER_API_KEY`.

## Tests

No test reaches Hunter. `tests/mapping.test.ts` runs the port's contract suite and every row above against a vendor on 127.0.0.1 (`../tests/fixtures/vendor.ts`) answering the synthetic `tests/fixtures/found.json` (shaped like Hunter's documentation, never recorded): the request, exactly the three parameters and the key in `X-API-KEY` only; each verdict; nobody found; the statuses; the pattern's redirect, bound and timeout and a refused connection; nothing of the key or the inputs left behind; and, in a child process, the allowance's default and `HUNTER_API_KEY` required at start. `tests/contract.test.ts` is the live suite: one lookup of the person the three `HUNTER_TEST_*` variables name, with `HUNTER_API_KEY`, all in the environment (`.env.local` is not read); skipped without them, refused under `APP_ENV=production`.
