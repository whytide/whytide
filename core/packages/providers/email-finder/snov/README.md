# snov: the email-finder adapter on Snov.io

**Covers.** `findEmail` of the [email-finder port](../README.md), with Snov.io's Email Finder by name and domain, v2 ([Snov.io's API documentation](https://snov.io/api), read 2026-11-13), in three calls to `https://api.snov.io`:

1. `POST /v1/oauth/access_token`, a form body with `grant_type=client_credentials`, `client_id` and `client_secret`: the only place the id and the secret go. The answer's `access_token` stays in memory, in the adapter's instance, and is reused until 60 seconds before its `expires_in`.
2. `POST /v2/emails-by-domain-by-name/start`, a JSON body `{ "rows": [{ "first_name", "last_name", "domain" }] }`, one row, nothing else; the token in `Authorization: Bearer`. The answer's `task_hash` names the task.
3. `GET /v2/emails-by-domain-by-name/result?task_hash=…`, read every 2 seconds until its `status` is `completed`.

A 401 on call 2 or 3 fetches the token again, once, and sends that call again, once; a second 401 is `finder_unauthorized`. The whole lookup, all its calls and waits, has a 10-second budget: a result not ready by then is `finder_provider_error`, `reason: "not_ready"`. The call is counted, and enrichment asks the next finder (gamma-en-080: no retry). Node's `fetch`, in this folder only (`client.ts`); no SDK; `redirect: "manual"`; each answer read up to 256 KiB.

## Mapping

The result holds the row's addresses, each with `smtp_status` and its flags. The adapter drops one with `is_valid_format: false`, takes the first `valid` one, else the first.

| Snov.io's answer | The port |
|---|---|
| `completed`, an address | `found`, the address lower case, at any domain |
| `is_webmail` or `is_disposable` true | `vendorVerdict: "risky"` |
| `smtp_status` `valid` | `vendorVerdict: "valid"` |
| `smtp_status` `unknown`, `unknown_status_reason` `catchall` | `vendorVerdict: "catch_all"`, never `valid` |
| `smtp_status` `unknown`, any other reason | `vendorVerdict: "unknown"` |
| any other `smtp_status`, or none | no `vendorVerdict` |
| `completed`, no address, or no row | `not_found` |
| `not_enough_credits` | `finder_allowance_spent`, `status: 200` |
| still `in_progress` when the 10 seconds end | `finder_provider_error`, `reason: "not_ready"` |
| a token call refused, `invalid_client` (400 or 401) | `finder_unauthorized`, `status` |
| 401 twice on a finder call; a 403 | `finder_unauthorized`, `status` |
| 402 | `finder_allowance_spent`, `status` |
| 429 | `finder_rate_limited`, `retryAfterSec` from `Retry-After`; else 60 |
| an address off the port's form; a status or a shape Snov.io does not document; a start without its task | `finder_provider_error`, `reason: "off_shape"` |
| a redirect; an answer past 256 KiB; not JSON | `finder_provider_error`, `status`, `reason` |
| 5xx, any other | `finder_provider_error`, `status` |
| no answer within the budget; a network error | `finder_provider_error`, `reason: "timeout"`; `"network"` |

**The docs.** Snov.io's documentation gives no HTTP status for a refused token, the rate limit or the credits gone, only the result's `not_enough_credits`: the status rows are the task's table, and the live check confirms them.

## Vendor and terms

- **The free plan** (Snov.io's pricing, read 2026-11-13): 50 credits a month; one per address found, `valid` or `unknown`. The API allows 60 calls a minute: one lookup makes at most 7, 9 with a token fetched again. Whether the free plan includes the API is the owner's to confirm: if it does not, the adapter stays out of `PROVIDER_EMAIL_FINDER` until a plan allows it.
- **Processing location, data processing agreement, keeping results:** the owner's to confirm. The adapter keeps nothing; the token lives in memory only.

## Variables

| Variable | |
|---|---|
| `SNOV_CLIENT_ID`, `SNOV_CLIENT_SECRET` (secrets; `requires` names both) | the account's API id and secret (app.snov.io/account/api); `create()` fails with `config_invalid` while either is empty |
| `SNOV_ALLOWANCE` | `<count>/day` or `<count>/month`; empty, the free plan's `50/month` |
| `SNOV_TEST_FIRST_NAME`, `SNOV_TEST_LAST_NAME`, `SNOV_TEST_DOMAIN` | the owner's, for the live case only, in the environment |

What the owner sets up: a free account at snov.io, its API id and secret.

## Tests

No test reaches Snov.io. `tests/mapping.test.ts` runs the port's contract suite and every row above against a vendor on 127.0.0.1 answering the synthetic `tests/fixtures/result.json`: the three requests, the id and the secret in the token call's form body only, the one row, the bearer token; the token fetched once and reused until it expires, a 401 fetching it once more; a result ready after a few reads, and one never ready; the verdicts; the statuses; the pattern; nothing of the id, the secret, the token or the inputs left behind; the allowance's default and both variables required at start. `tests/contract.test.ts` is the live suite: one lookup of the person the three `SNOV_TEST_*` variables name; skipped without them or the credentials, refused under `APP_ENV=production`.
