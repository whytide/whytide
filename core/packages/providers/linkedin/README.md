# The LinkedIn port

Every LinkedIn call of the product goes through this port: the user's own account, connected through the vendor's hosted authentication, then reads within the cap ([security §1](../../../../docs/rules/security.md#1-red-lines), [architecture §9](../../../../docs/architecture.md#9-ports-and-adapters)). Five read-side methods; nothing here sends anything.

```ts
import { getAdapter, linkedinConfig, linkedinPort } from "@whytide/providers";

const linkedin = await getAdapter(linkedinPort, linkedinConfig.PROVIDER_LINKEDIN); // at start
const { url, providerRef } = await linkedin.createHostedAuthLink({ successUrl, failureUrl, expiresInMin: 30 });
```

| Method | Takes | Gives |
|---|---|---|
| `createHostedAuthLink` | `successUrl`, `failureUrl`, `expiresInMin` (1 to 1,440) | `HostedAuthLink { url, expiresAt, providerRef }`: send the browser to `url`; keep `providerRef` with the pending connection |
| `getAccountStatus` | `providerAccountRef` | `AccountStatus { status, checkedAt }`, `status` one of `connected`, `disconnected`, `credentials_required`, `error` |
| `listPostEngagers` | `providerAccountRef`, `postUrl`, `cursor?`, `limit` (1 to 100) | `{ engagers: Engager[], nextCursor }`, newest first by `engagedAt` across pages (a caller stops at its watermark), `nextCursor` null on the last page; a cursor reads the same page again |
| `getProfile` | `providerAccountRef`, `profileUrl` | `Profile` |
| `parseWebhook` | `{ headers, rawBody }`, the request as received, the body's raw bytes or their text | `{ kind, providerAccountRef, providerRef? }`, `kind` one of `account.connected`, `account.disconnected`, `account.credentials_required`; `providerRef` on `account.connected`, the link's |

`postUrl` and `profileUrl` are https URLs on `linkedin.com`. `parseWebhook` checks the vendor's signature before it reads the body, in constant time, with a secret from the adapter's config that nothing logs; `PROVIDER_LINKEDIN` (`config.ts`) names the adapter.

## Profiles and engagers

`Profile { providerMemberRef, profileUrl, firstName, lastName, headline, title, companyName, companyUrl?, locationText, industry?, fetchedAt }` and `Engager { providerMemberRef, profileUrl, name, headline, reaction, commentText?, engagedAt }` hold business fields only. `linkedinProfile` and `linkedinEngager` are their schemas: parsing drops every other key, so an adapter returns `linkedinProfile.parse(mapped)` and a vendor's email, phone or photo stops there, in production too, where the boundary passes outputs through unchecked. In tests the method outputs are strict and refuse any other key. Names and headlines are personal data: never log them.

## Codes

| Code | When |
|---|---|
| `linkedin_rate_limited` (429) | the vendor's rate limit; `details.retryAfterSec` is the wait in seconds |
| `linkedin_account_disconnected` (409) | the account is not connected: disconnected, or its credentials are needed |
| `linkedin_not_found` (404) | no such account, post or profile, or none the account can see |
| `linkedin_webhook_invalid` (401) | a webhook whose signature does not match, or whose body is not the vendor's |
| `linkedin_provider_error` (502) | anything else the vendor answered: `details.status`, never its body |
| `linkedin_input_invalid`, `linkedin_output_invalid`, `linkedin_error_unmapped` | the pattern's own ([../README.md](../README.md) "The boundary") |

Developer-facing: no message keys.

## What the port will never have

A password, a cookie or a second-factor secret; a shared, rented or fake account; scraping. A profile's contact info (email, phone, address), its photo, birthday or pronouns, a special-category field or anything a visibility setting hides: no type here can carry them, and a test fails on the first of them added. Sending (connection requests, messages), profile views, company pages, the inbox: later versions, each as a new method.

## Adapters

| `PROVIDER_LINKEDIN` | |
|---|---|
| `fake` | in memory, the default in `deploy/.env.example` (below) |
| `unipile` | Unipile's REST API over `fetch`, no SDK ([unipile/README.md](unipile/README.md)); `unipile-node-sdk` stays listed in `tools/lint/vendor-sdks.json` for `linkedin/unipile/` only |

## The fake

Accounts, posts and profiles in memory; module tests reach it as `(await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake`. Its controls, beside `recordedCalls` and `reset()`:

| Control | Does |
|---|---|
| `seedPost(postUrl, engagers)` | a post `listPostEngagers` pages newest first by `engagedAt`, ties in the order given; an unseeded post is `linkedin_not_found` |
| `seedProfile(profile)` | a profile `getProfile` returns, `fetchedAt` set at the read |
| `emitWebhook(kind, providerAccountRef)` | the account takes the kind's status, created if need be, and the signed webhook `{ headers, rawBody }` is returned for the test to deliver |
| `connectOnVisit(deliver?)` | a connect-style handler serving `GET /api/linkedin/fake/connect?link=…`, where the fake's hosted links point (on the success URL's origin), under `APP_ENV=test` only: a visit connects a new account, hands its `account.connected` webhook to `deliver` and answers 303 to the success URL; an expired link goes to the failure URL, an unknown or used one to `next()` |
| `failNext(code, details?)` | the next call throws the code; `linkedin_rate_limited` carries `retryAfterSec: 60` unless `details` give one |

Reads need a connected account: an unknown one is `linkedin_not_found`, any other status `linkedin_account_disconnected`. Its webhooks carry `x-linkedin-fake-signature: sha256=<HMAC-SHA256 of the raw body>` under a secret drawn at start: only `emitWebhook` and the route sign one.

## The contract suite

`contract.ts` holds `linkedinCases(world)`: a hosted link connects the account and its status is `connected`; engagers over three pages with a stable cursor, newest first; a profile; a signed webhook parsed and a forged or unsigned one refused; the rate limit with `retryAfterSec`; `linkedin_not_found` on an unknown post. The `LinkedinWorld` is the adapter's side: how a user connects through a link, a post and a profile the account can read, the vendor's signed and forged webhooks, and `rateLimitNext` when the vendor can be made to rate-limit (the case skips without it). `fake/tests/contract.test.ts` seeds ninety engagers and serves the route on a local server; `tests/contract.test.ts` holds the port's own tests: the five methods through the registry, the shape check, the profile schema, the lint.

A new method: its schemas in `port.ts`, its case in `contract.ts`, then the fake and every adapter.
