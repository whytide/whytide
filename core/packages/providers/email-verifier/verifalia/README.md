# verifalia: the email-verifier adapter on Verifalia

**Covers.** `verifyEmail` of the [email-verifier port](../README.md), as one job of one entry ([core concepts](https://verifalia.com/developers/core-concepts), [creating jobs](https://verifalia.com/developers/email-verifications/creating-jobs), [retrieving jobs](https://verifalia.com/developers/email-verifications/retrieving-jobs), read 2026-11-13):

1. `POST https://api.verifalia.com/v2.7/email-validations?waitTime=<ms>`, the body `{"entries":[{"inputData":"<address>"}]}`: the address alone, nothing else of the job (its quality, retention and name stay the account's);
2. while the answer is 202, the job still running: `GET …/email-validations/<overview.id>?waitTime=<ms>`, by the id in the body, never the `Location` header.

The user's credentials go by HTTP basic auth, in the `Authorization` header only. **The budget:** the whole check, the job created and read, takes at most 10 seconds; each request asks the vendor to wait the budget left less one second, and its own timeout is the budget left. A job not done when the budget runs out, or after 5 reads, is `verifier_provider_error`, `reason: "job_unfinished"`: no retry, the job counted, and enrichment passes the address to the next verifier (gamma-en-080, the owner's rule of 2026-11-13). Node's `fetch`, in this folder only; no SDK. `redirect: "manual"`, answers read up to 64 KiB.

## Mapping

On the job's one entry, its `status` first where it decides, else its `classification`:

| The vendor's answer | Verdict |
|---|---|
| `status: "ServerIsCatchAll"`, whatever the classification | `catch_all`, never `valid` |
| `MailboxHasInsufficientStorage` (a full mailbox), `MailboxIsDea`, `DomainIsWellKnownDea`, `MailExchangerIsWellKnownDea` (disposable), `MailExchangerIsHoneypot` | `risky` |
| `classification: "Deliverable"` | `valid` |
| `classification: "Risky"` | `risky` |
| `classification: "Undeliverable"` | `invalid` |
| `classification: "Unknown"`, or a custom one | `unknown` |

| The vendor's answer | The port |
|---|---|
| 402 (credit too low, or the monthly limit) | `verifier_allowance_spent` |
| 401, 403 (the user lacks `email-validations:write:my`) | `verifier_unauthorized` |
| 429 (18 requests a second per address) | `verifier_rate_limited`, `retryAfterSec` from `Retry-After`, else 1 |
| a job still running past the budget or 5 reads | `verifier_provider_error`, `reason: "job_unfinished"` |
| a 202 without its `overview.id`; a 200 whose job is not `Completed` or has no entry; 2xx not JSON | `verifier_provider_error`, `reason` `off_shape` or `not_json` |
| a redirect; past 64 KiB; any other status (410, 5xx); no answer in time; a network error | `verifier_provider_error` with `status` or `reason` |

## Vendor and terms

- **The free plan** (the owner's numbers of 2026-11-13, from the task; the pricing page is the owner's to check): 25 checks a day. Verifalia keeps a job 30 days by default; a shorter `retention` needs a delete permission, which the Whytide user does not have, so a shorter one is the owner's to set on the account, if Verifalia allows it there.
- **The user.** A user made for Whytide in Verifalia's console, with the verification rights only (`email-validations:write:my` and reading its own jobs), not the account's root credentials.
- **Use in a product, processing location, data processing agreement:** the owner's to confirm. The adapter is merged without a user.

## Variables

| Variable | |
|---|---|
| `VERIFALIA_USERNAME`, `VERIFALIA_PASSWORD` (secret); `requires` names both | the user's; `create()` fails with `config_invalid` while either is empty |
| `VERIFALIA_ALLOWANCE` | the checks per period enrichment allows; empty, the free plan's `25/day` |
| `VERIFALIA_TEST_ADDRESS` | the owner's, for the live case only, in the environment: one address the owner controls |

**Provider refs.** None: the job's id is not kept. **Known differences.** The documentation names `api-1`, `api-2` and `api-3` for failover; the adapter uses the round-robin `api.verifalia.com` and fails over to the next verifier, not the next host.

## Tests

No test reaches the vendor. `tests/mapping.test.ts`: the port's contract suite and every row above on 127.0.0.1, synthetic jobs shaped like the documentation: the creation, exactly the one entry and the basic auth; a job read again by its id until done; one not done after 5 reads or past the budget; each verdict row; each code, on a read too; the redirect, the bound, the 10-second budget and a refused connection; nothing of the user, the password or the address left behind; the allowance's default and both variables required at start. `tests/contract.test.ts`, live: one check of `VERIFALIA_TEST_ADDRESS`; skipped without it and the user, refused under `APP_ENV=production`.
