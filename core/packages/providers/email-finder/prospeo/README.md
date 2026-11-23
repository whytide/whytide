# prospeo: the email-finder adapter on Prospeo

**Covers.** `findEmail` of the [email-finder port](../README.md), with one call: `POST https://api.prospeo.io/enrich-person`, Enrich Person ([Prospeo's API documentation](https://prospeo.io/api-docs/enrich-person), read 2026-11-13), Prospeo's call that finds a person's address from a name and a company. Its JSON body is `{ "only_verified_email": true, "data": { "first_name", "last_name", "company_website" } }`: the two names and the company's domain, and nothing else about the person; `only_verified_email` is a switch, so that Prospeo answers, and charges for, only an address it verified itself. The key travels in the `X-KEY` header, never in the URL or the body. Node's `fetch`, in this folder only (`client.ts`), to Prospeo's fixed host; no SDK. A 30-second timeout, `redirect: "manual"`, an answer read up to 256 KiB, no retry: on any error enrichment asks the next finder (gamma-en-080). The rest of Prospeo's answer, the person's record (job, location, mobile) and the company's, is left unread.

## Mapping

Prospeo's errors are 400s whose body names them, `{ "error": true, "error_code": "…" }`; the adapter reads `error_code` first, then the status.

| Prospeo's answer | The port |
|---|---|
| 2xx, `person.email.email` set | `found`, the address lower case, at any domain |
| `person.email.status` `VERIFIED` | `vendorVerdict: "valid"` |
| any other `status`, or none | no `vendorVerdict` |
| `NO_MATCH` (nobody, or no verified address) | `not_found` (Prospeo charges nothing) |
| 2xx with no `person`, no `email`, or `revealed: false` (a masked snippet) | `not_found` |
| 2xx with an address off the port's form; JSON off Prospeo's shape | `finder_provider_error`, `reason: "off_shape"` |
| 2xx that is not JSON | `finder_provider_error`, `status`, `reason: "not_json"` |
| `INSUFFICIENT_CREDITS`; a 402 | `finder_allowance_spent`, `status` |
| `INVALID_API_KEY`; a 401, a 403 | `finder_unauthorized`, `status` |
| 429 ("Rate limit exceeded") | `finder_rate_limited`, `retryAfterSec` from `Retry-After`; else 60 |
| `INVALID_DATAPOINTS`, `INVALID_REQUEST`, `INTERNAL_ERROR`, 5xx, any other | `finder_provider_error`, `status` |
| a redirect; an answer past 256 KiB | `finder_provider_error`, `status`, `reason: "redirect"`, `"answer_too_large"` |
| no answer in 30 s; a network error | `finder_provider_error`, `reason: "timeout"`; `"network"` |

**The docs win.** gamma-en-090's table reads a refused key as a 401 or 403 and the credits gone as their own status; Prospeo answers both as 400s named in the body, so the adapter reads the name. Prospeo's documentation shows only the `VERIFIED` status.

## Vendor and terms

- **The free plan** (Prospeo's pricing, read 2026-11-13): 75 credits a month; one per address found, nothing found free, the same record again within 90 days free. Whether the free plan includes the API is the owner's to confirm: if it does not, the adapter stays out of `PROVIDER_EMAIL_FINDER` until a plan allows it (the task's Open questions).
- **Processing location, data processing agreement, keeping results:** the owner's to confirm. The adapter keeps nothing.

## Variables

| Variable | |
|---|---|
| `PROSPEO_API_KEY` (secret; `requires` names it) | the account's API key; `create()` fails with `config_invalid` while it is empty |
| `PROSPEO_ALLOWANCE` | `<count>/day` or `<count>/month`; empty, the free plan's `75/month` |
| `PROSPEO_TEST_FIRST_NAME`, `PROSPEO_TEST_LAST_NAME`, `PROSPEO_TEST_DOMAIN` | the owner's, for the live case only, in the environment |

What the owner sets up: a free account at prospeo.io and its key.

## Tests

No test reaches Prospeo. `tests/mapping.test.ts` runs the port's contract suite and every row above against a vendor on 127.0.0.1 answering the synthetic `tests/fixtures/found.json`: the request's body, exactly the three fields and the switch, and the key in `X-KEY` only; the verdict; nobody found; the error codes and statuses; the pattern; nothing of the key or the inputs left behind; the allowance's default and `PROSPEO_API_KEY` required at start. `tests/contract.test.ts` is the live suite: one lookup of the person the three `PROSPEO_TEST_*` variables name; skipped without them or the key, refused under `APP_ENV=production`.
