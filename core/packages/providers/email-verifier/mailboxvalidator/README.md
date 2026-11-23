# mailboxvalidator: the email-verifier adapter on MailboxValidator

**Covers.** `verifyEmail` of the [email-verifier port](../README.md), with one call: `GET https://api.mailboxvalidator.com/v2/validation/single?email=<address>&key=<key>` ([single validation API](https://www.mailboxvalidator.com/api-single-validation), read 2026-11-13). The address and the key, nothing else (`format` defaults to JSON). Node's `fetch`, in this folder only, to the vendor's fixed host; no SDK. A 30-second timeout, `redirect: "manual"`, an answer read up to 64 KiB, no retry.

## Mapping

Each flag is `true`, `false` or `null` (not checked).

| The vendor's answer | Verdict |
|---|---|
| `is_syntax`, `is_domain` or `is_verified` false | `invalid` |
| `is_catchall: true`, whatever else | `catch_all`, never `valid` |
| `is_disposable`, `is_role`, `is_suppressed` (its do-not-mail list) or `is_high_risk` true | `risky` |
| `status: true` and `is_verified: true` | `valid` |
| anything else: `is_verified: null`, a server down, greylisting | `unknown` |

| The vendor's answer | The port |
|---|---|
| `error.error_code` 10004 ("Insufficient credits", sent with a 401), at any status; a 402 | `verifier_allowance_spent` |
| `error_code` 10001 to 10003 (the key not found, disabled, expired); a 401 or 403 without them | `verifier_unauthorized` |
| 429 | `verifier_rate_limited`, `retryAfterSec` from `Retry-After`, else 60 |
| `error_code` 10000 or 10005, or any other error; 2xx not JSON; no boolean `status` | `verifier_provider_error`, with `status`, or `reason` `not_json` or `off_shape` |
| a redirect; past 64 KiB; any other status; no answer in 30 s; a network error | `verifier_provider_error` with `status` or `reason` |

## Vendor and terms

- **The free plan** (the owner's numbers of 2026-11-13, from the task; the pricing page is the owner's to check): 300 credits a month, counted over 30 days from the sign-up, not the calendar month; `MAILBOXVALIDATOR_ALLOWANCE=300/month` is the nearest.
- **The key in the URL.** The vendor takes it in the query string only, with the address: the URL goes to `fetch` and nowhere else.
- **Use in a product, retention, processing location, data processing agreement:** the owner's to confirm (the task's Open questions). The adapter is merged without a key.

## Variables

| Variable | |
|---|---|
| `MAILBOXVALIDATOR_API_KEY` (secret; `requires` names it) | the account's API key; `create()` fails with `config_invalid` while it is empty |
| `MAILBOXVALIDATOR_ALLOWANCE` | the checks per period enrichment allows; empty, the free plan's `300/month` |
| `MAILBOXVALIDATOR_TEST_ADDRESS` | the owner's, for the live case only, in the environment: one address the owner controls |

What the owner sets up: a free account at mailboxvalidator.com and its API key.

**Provider refs.** None. **Known differences.** `mailboxvalidator_score` is not read; the flags decide.

## Tests

No test reaches the vendor. `tests/mapping.test.ts`: the port's contract suite and every row above on 127.0.0.1, synthetic answers shaped like the documentation: the request, exactly the address and the key; each verdict row; each error code at its status and at 200; the redirect, the bound, the timeout and a refused connection; nothing of the key, the address or the URL left behind; the allowance's default and the key required at start. `tests/contract.test.ts`, live: one check of `MAILBOXVALIDATOR_TEST_ADDRESS`; skipped without it and the key, refused under `APP_ENV=production`.
