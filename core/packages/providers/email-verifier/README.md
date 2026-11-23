# The email-verifier port

One address's verdict, in our words ([architecture §9](../../../../docs/architecture.md#9-ports-and-adapters)). One method, `verifyEmail`. Its input is the address and nothing else, so nothing about the person, their name, their company or their id, reaches a verifier (RB-7.3.1). `PROVIDER_EMAIL_VERIFIER` (`config.ts`) lists the adapters, in the order enrichment gives them their turns; each declares its free allowance ([../README.md](../README.md) "Many adapters per port"). The turns, counting the checks, the cache and what a verdict means for sending are enrichment's (gamma-en-080), not the port's.

```ts
import { emailVerifierConfig, emailVerifierPort, getAdapters } from "@whytide/providers";

const verifiers = await getAdapters(emailVerifierPort, emailVerifierConfig.PROVIDER_EMAIL_VERIFIER); // at start
const { verdict, checkedAt } = await verifiers[0].verifyEmail({ address: "ada@example.com" });
// verifiers[0].allowance: { calls, per } or null
```

| Method | Takes | Gives |
|---|---|---|
| `verifyEmail` | `{ address }`, nothing else | `{ verdict, checkedAt }` |

| Field | Shape |
|---|---|
| `address` | an address, lower case, at most 254 characters: a plain local part (letters, digits, `_'+-`, dot-separated) at a host name of two labels or more; no display name, quotes or space |
| `verdict` | one of the five of RB-7.1.1 and the data model's `ContactPoint.verification`: `valid`, `catch_all`, `risky`, `invalid`, `unknown` |
| `checkedAt` | a `Date`, when the vendor checked |

`catch_all` is a verdict of its own, never folded into `valid` ("Verified emails only. No guessing at catch-all domains"); what each verdict means for sending is enrichment's rule. The input is a strict object: any other key, or an address off its form, is `verifier_input_invalid` before any call. The outputs are checked in every environment, production included (`alwaysCheckOutputs`): an answer off these shapes, a sixth verdict or a vendor's field, is `verifier_output_invalid`.

## Codes

| Code | When |
|---|---|
| `verifier_rate_limited` (429) | the vendor's rate limit; `details.retryAfterSec` is the wait in seconds |
| `verifier_allowance_spent` (402) | the vendor's free checks or credits are gone: its 402, or its own "quota used"; never retried |
| `verifier_unauthorized` (401) | the vendor refused the key |
| `verifier_provider_error` (502) | anything else the vendor answered: `details.status`, never its body |
| `verifier_input_invalid`, `verifier_output_invalid`, `verifier_error_unmapped` | the pattern's own ([../README.md](../README.md) "The boundary") |

Developer-facing: no message keys.

## What the port will never have

Anything about the person beside the address: a name, a company, an id. The input's strict shape refuses each before any call, and the output's refuses a field it does not declare, the address given back included. The port logs nothing and opens no span; no address reaches an error, a log line or a metric label (`tests/contract.test.ts`).

## Adapters

| `PROVIDER_EMAIL_VERIFIER` | `<ADAPTER>_ALLOWANCE` | Vendor |
|---|---|---|
| [`quickemailverification`](quickemailverification/README.md) | `100/day` | QuickEmailVerification, `/v1/verify`, free plan |
| [`mailboxvalidator`](mailboxvalidator/README.md) | `300/month` | MailboxValidator, v2 single validation, free plan |
| [`verifalia`](verifalia/README.md) | `25/day` | Verifalia, a job of one entry, free plan |
| [`zerobounce`](zerobounce/README.md) | `100/month` | ZeroBounce, v2 validate, free plan |
| [`reoon`](reoon/README.md) | `20/day` | Reoon Email Verifier, power mode, free plan |

Each adapter's README has its call, its verdict table, its free plan's numbers and their date, its terms and what the owner sets up (gamma-en-095, gamma-en-096). `deploy/.env.example` lists the fake; `deploy/.env.production.example` names the five in the owner's order, `quickemailverification,mailboxvalidator,verifalia,zerobounce,reoon`, each of which fails at start without its credentials. An empty list loads no adapter: no address is verified.

What the adapters share. One verdict rule: an answer that the address does not exist is `invalid`; else any sign that the domain accepts every address is `catch_all`, never `valid`, whatever else the answer says; else disposable, role, spam trap, abuse, do-not-mail or a full inbox is `risky`; a deliverable address `valid`; anything else `unknown`. One reading of failures, `answer.ts`: an answer read up to the adapter's bound, a redirect never followed, the vendor's own error answer first (MailboxValidator's 10004, ZeroBounce's and Reoon's error bodies, at any status), then 402 `verifier_allowance_spent`, 401 and 403 `verifier_unauthorized`, 429 `verifier_rate_limited` and any other `verifier_provider_error` with the status, never the body; a timeout or a network error the provider error with its `reason`. No adapter retries: enrichment passes the address to the next verifier on any code (gamma-en-080). Four vendors take their key, and the address, in the query string: that URL goes to `fetch` only, never to an error, a log line, a span or a metric, which each `tests/mapping.test.ts` checks. `tests/fixtures/vendor.ts` serves a vendor's answers on 127.0.0.1, with company-data's recording server; `tests/fixtures/live.ts` is each adapter's live suite, one check of `<ADAPTER>_TEST_ADDRESS`; `tests/adapters.test.ts` loads the five in order.

## The fake

Every address is `valid`, checked now, unless a test set another verdict. Module tests reach it as `(await getAdapter(emailVerifierPort, "fake")) as unknown as EmailVerifierFake`. Its `create()` refuses `APP_ENV=production` with `adapter_invalid`: the fake never stands in for a vendor on a server. Its controls, beside `recordedCalls`, `answerNext` and `reset()`:

| Control | Does |
|---|---|
| `verdictFor(address, verdict)` | a check of `address`, in any case, answers `verdict`, any of the five, until the next `reset()` |
| `setAllowance(allowance)` | the allowance the bound fake exposes, `{ calls, per }` or null, until the next `reset()`, so that enrichment's tests count against one |
| `failNext(code, details?)` | the next call throws the code; `verifier_rate_limited` carries `retryAfterSec: 60` and `verifier_provider_error` `status: 500`, unless `details` give them |

## The contract suite

`contract.ts` holds `emailVerifierCases(world)`: the address the world names checked, in the port's words; each of the five verdicts answered as the vendor gave it, `catch_all` apart from `valid`; anything but the address alone, or an address off its form, refused before any call, `verifier_input_invalid`, with nothing recorded; each of the port's four codes from the vendor's next answer, the call after it checking the address again. An offline world, the fake or an adapter's recorded answers, gets every case through its hooks `address(verdict)`, `failNext(code)` and `calls()`.

**A live world, the vendor's API with the owner's key, gets exactly one check**, of the one address the world names, an address the owner controls, and every other case skips (`offline only: a live run makes one check`): a free plan's checks are few. The live suite refuses to start under `APP_ENV=production`. `tests/fixtures/live-world.ts` holds the rule on a stand-in adapter, never a vendor.

The suite runs on the fake from `fake/tests/contract.test.ts` and, taken from the registry through `PROVIDER_EMAIL_VERIFIER`, from `tests/contract.test.ts` (`pnpm -F providers test:contract`), which also holds the port's own tests: the codes, the output check, nothing logged. A new method: its schemas in `port.ts`, its case in `contract.ts`, then the fake and every adapter.
