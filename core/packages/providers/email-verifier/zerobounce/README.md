# zerobounce: the email-verifier adapter on ZeroBounce

**Covers.** `verifyEmail` of the [email-verifier port](../README.md), with one call: `GET https://api.zerobounce.net/v2/validate?email=<address>&api_key=<key>` ([Single Email Validator, real time (v2)](https://www.zerobounce.net/docs/email-validation-api-quickstart/v2-validate-emails), its [response](https://www.zerobounce.net/docs/email-validation-api-quickstart/v2-validate-emails/response) and [status codes](https://www.zerobounce.net/docs/email-validation-api-quickstart/v2-status-codes), read 2026-11-13). The address and the key, never `ip_address`, `timeout` or `activity_data`. Node's `fetch`, in this folder only; no SDK. A 30-second timeout (the vendor's own default), `redirect: "manual"`, an answer read up to 64 KiB, no retry.

## Mapping

| The vendor's answer | Verdict |
|---|---|
| `status: "invalid"`, a full mailbox aside | `invalid` |
| `status: "catch-all"`; `valid` with `sub_status` `accept_all` or `role_based_accept_all` (its vetted accept-all domains); `catchall_domain: true`, whatever else | `catch_all`, never `valid` |
| `spamtrap`, `abuse`, `do_not_mail` (role, disposable, toxic, global suppression, possible trap); `invalid` with `mailbox_quota_exceeded` | `risky` |
| `status: "valid"` (alias, alternate, gold and the rest) | `valid` |
| `status: "unknown"`, or a status it does not list | `unknown` |

| The vendor's answer | The port |
|---|---|
| `{"error": "Invalid API Key or your account ran out of credits"}`, at any status: a text naming the credits | `verifier_allowance_spent` |
| an error naming the key alone; 401, 403 | `verifier_unauthorized` |
| 429 (its one-minute block) | `verifier_rate_limited`, `retryAfterSec` from `Retry-After`, else 60 |
| any other error answer; 2xx not JSON; no `status` | `verifier_provider_error`, with `status`, or `reason` `not_json` or `off_shape` |
| a redirect; past 64 KiB; any other status; no answer in 30 s; a network error | `verifier_provider_error` with `status` or `reason` |

The vendor's one error answer names both a bad key and the credits used, so it is read as the credits used: never retried, the next verifier checks the address. A key that keeps failing is blocked an hour after 200 bad calls.

## Vendor and terms

- **The free plan** (the owner's numbers of 2026-11-13, from the task; the pricing page is the owner's to check): 100 checks a month; the sign-up needs a business domain. An `unknown` result costs no credit.
- **The answer holds more than a verdict:** the owner's first and last name, gender and location where ZeroBounce has them. The adapter reads `status`, `sub_status` and `catchall_domain` only; nothing else is kept.
- **The key in the URL.** The vendor takes it in the query string only, with the address: the URL goes to `fetch` and nowhere else.
- **Processing location:** the default host; `api-us.zerobounce.net` (US only) and `api-eu.zerobounce.net` (EU) exist and are not used. Use in a product, retention, data processing agreement: the owner's to confirm. The adapter is merged without a key.

## Variables

| Variable | |
|---|---|
| `ZEROBOUNCE_API_KEY` (secret; `requires` names it) | the account's API key; `create()` fails with `config_invalid` while it is empty |
| `ZEROBOUNCE_ALLOWANCE` | the checks per period enrichment allows; empty, the free plan's `100/month` |
| `ZEROBOUNCE_TEST_ADDRESS` | the owner's, for the live case only, in the environment: one address the owner controls |

**Provider refs.** None.

## Tests

No test reaches the vendor. `tests/mapping.test.ts`: the port's contract suite and every row above on 127.0.0.1, synthetic answers shaped like the documentation: the request, exactly the address and the key; each verdict row; the error answer at 200 and 400; the redirect, the bound, the timeout and a refused connection; nothing of the key, the address, the URL or a name it gives back left behind; the allowance's default and the key required at start. `tests/contract.test.ts`, live: one check of `ZEROBOUNCE_TEST_ADDRESS`; skipped without it and the key, refused under `APP_ENV=production`.
