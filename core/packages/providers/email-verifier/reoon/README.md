# reoon: the email-verifier adapter on Reoon Email Verifier

**Covers.** `verifyEmail` of the [email-verifier port](../README.md), with one call: `GET https://emailverifier.reoon.com/api/v1/verify?email=<address>&key=<key>&mode=power` ([API documentation of Reoon Email Verifier](https://www.reoon.com/articles/api-documentation-of-reoon-email-verifier/), read 2026-11-13). The address, the key and the mode, nothing else. Power mode checks the mailbox itself and the catch-all domain; quick mode marks every address of a good domain valid, so it is never used. Node's `fetch`, in this folder only; no SDK. A 30-second timeout, `redirect: "manual"`, an answer read up to 64 KiB, no retry.

## Mapping

| The vendor's answer | Verdict |
|---|---|
| `status` `invalid` or `disabled` | `invalid` |
| `status: "catch_all"`, or `is_catch_all: true` whatever else | `catch_all`, never `valid` |
| `status` `disposable`, `inbox_full`, `role_account` or `spamtrap` | `risky` |
| `status: "safe"` | `valid` |
| `status: "unknown"`, or a status it does not list (quick mode's `valid` among them) | `unknown` |

| The vendor's answer | The port |
|---|---|
| `{"status": "error", "reason": …}`, at any status, its reason naming the credits, the balance or the quota; a 402 | `verifier_allowance_spent` |
| an error whose reason names the key; 401, 403 | `verifier_unauthorized` |
| 429 | `verifier_rate_limited`, `retryAfterSec` from `Retry-After`, else 60 |
| any other error answer; 2xx not JSON; no `status` | `verifier_provider_error`, with `status`, or `reason` `not_json` or `off_shape` |
| a redirect; past 64 KiB; any other status; no answer in 30 s; a network error | `verifier_provider_error` with `status` or `reason` |

The documentation gives the error answer's shape, not its reasons or statuses: the reasons above are read by their words. Power mode can take more than 30 seconds on a slow mail server: that check is the provider error, and the next verifier checks the address.

## Vendor and terms

- **The free plan** (the owner's numbers of 2026-11-13, from the task; the pricing page is the owner's to check): daily credits, 20 a day by the task (the site's banner offers "up to 600 credits a month"). Whether they renew without a login is the owner's to confirm (the task's Open questions); until then it stays last in the list.
- **The key in the URL.** The vendor takes it in the query string only, with the address: the URL goes to `fetch` and nowhere else. The vendor asks for at most 5 checks at once on this endpoint; enrichment checks one address at a time.
- **Use in a product, retention, processing location (Reoon is in Bangladesh), data processing agreement:** the owner's to confirm. The adapter is merged without a key.

## Variables

| Variable | |
|---|---|
| `REOON_API_KEY` (secret; `requires` names it) | the account's API key; `create()` fails with `config_invalid` while it is empty |
| `REOON_ALLOWANCE` | the checks per period enrichment allows; empty, the free plan's `20/day` |
| `REOON_TEST_ADDRESS` | the owner's, for the live case only, in the environment: one address the owner controls |

**Provider refs.** None.

## Tests

No test reaches the vendor. `tests/mapping.test.ts`: the port's contract suite and every row above on 127.0.0.1, synthetic answers shaped like the documentation: the request, exactly the address, the key and power mode; each verdict row; the error answer at 200, 400 and 500; the redirect, the bound, the timeout and a refused connection; nothing of the key, the address or the URL left behind; the allowance's default and the key required at start. `tests/contract.test.ts`, live: one check of `REOON_TEST_ADDRESS`; skipped without it and the key, refused under `APP_ENV=production`.
