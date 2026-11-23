# quickemailverification: the email-verifier adapter on QuickEmailVerification

**Covers.** `verifyEmail` of the [email-verifier port](../README.md), with one call: `GET https://api.quickemailverification.com/v1/verify?email=<address>&apikey=<key>` ([Verify an email address](https://docs.quickemailverification.com/email-verification-api/verify-an-email-address) and [Kick start with email validation API](https://docs.quickemailverification.com/email-verification-api/kick-start-with-email-validation-api), read 2026-11-13). The address and the key, nothing else. Node's `fetch`, in this folder only, to the vendor's fixed host; no SDK, so no entry in `tools/lint/vendor-sdks.json`. A 30-second timeout, `redirect: "manual"`, an answer read up to 64 KiB, no retry.

## Mapping

The answer's booleans come as text (`"true"`) or as JSON; both are read.

| The vendor's answer | Verdict |
|---|---|
| `result: "invalid"` (`rejected_email`, `invalid_domain`, `invalid_email`, `no_mx_record`) | `invalid` |
| `accept_all: true`, whatever else, an invalid result aside | `catch_all`, never `valid` |
| `disposable: true`, `role: true`, or `reason: "exceeded_storage"` (a full mailbox) | `risky` |
| `result: "valid"` | `valid` |
| `result: "unknown"`, or a result it does not list | `unknown` |

| The vendor's answer | The port |
|---|---|
| 402 ("running out of your credit limit") | `verifier_allowance_spent` |
| 401 (the key), 403 (the account disabled) | `verifier_unauthorized` |
| 429 | `verifier_rate_limited`, `retryAfterSec` from `Retry-After`, else 60 |
| 2xx that is not JSON; `success` not true, or no `result` | `verifier_provider_error`, `reason` `not_json` or `off_shape` |
| a redirect; past 64 KiB; any other status; no answer in 30 s; a network error | `verifier_provider_error` with `status` or `reason` |

## Vendor and terms

- **The free plan** (the owner's numbers of 2026-11-13, from the task; the pricing page is the owner's to check): 100 checks a day, renewed daily; credits bought apart from the plan stay. `X-QEV-Remaining-Credits` gives the balance; the adapter does not read it.
- **The key in the URL.** The vendor takes it in the query string only, with the address: the URL goes to `fetch` and nowhere else, never to an error, a log line, a span or a metric (`../README.md` "Adapters").
- **Use in a product, retention, processing location, data processing agreement:** the owner's to confirm (the task's Open questions). The adapter is merged without a key; a host whose list names it without `QUICKEMAILVERIFICATION_API_KEY` fails at start.

## Variables

| Variable | |
|---|---|
| `QUICKEMAILVERIFICATION_API_KEY` (secret; `requires` names it) | the account's API key; `create()` fails with `config_invalid` while it is empty |
| `QUICKEMAILVERIFICATION_ALLOWANCE` | the checks per period enrichment allows; empty, the free plan's `100/day` |
| `QUICKEMAILVERIFICATION_TEST_ADDRESS` | the owner's, for the live case only, in the environment: one address the owner controls |

What the owner sets up: a free account at quickemailverification.com and its API key.

**Provider refs.** None: the adapter stores nothing.

**Known differences.** The vendor's `safe_to_send` is not read: the flags above decide.

## Tests

No test reaches the vendor. `tests/mapping.test.ts` runs the port's contract suite and every row above against a vendor on 127.0.0.1 answering synthetic answers shaped like the documentation, never recorded: the request, exactly the address and the key; each verdict row; each code; the redirect, the bound, the timeout and a refused connection; nothing of the key, the address or the URL left behind; and, in a child process, the allowance's default and the key required at start. `tests/contract.test.ts` is the live suite: one check of `QUICKEMAILVERIFICATION_TEST_ADDRESS` with the key, both in the environment; skipped without them, refused under `APP_ENV=production`.
