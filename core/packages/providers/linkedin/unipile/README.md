# unipile: the LinkedIn port's Unipile adapter

**Covers.** The five methods of the [LinkedIn port](../README.md) on Unipile's REST API (`/api/v1`), with Node's `fetch` from this folder only. No SDK: `unipile-node-sdk` is ISC, outside the licence list, for a handful of calls; its entry in `tools/lint/vendor-sdks.json` stays, so that the SDK, if it is ever added, is kept in this folder too.

| Method | Unipile |
|---|---|
| `createHostedAuthLink` | `POST /hosted/accounts/link`: `type: create`, `providers: [LINKEDIN]`, our success and failure URLs, `expiresOn`, `notify_url` (`UNIPILE_NOTIFY_URL`), `name` (the link's `providerRef`, `whytide-<uuid>`), `single_use: true`, `disabled_options: [cookie_auth]` |
| `getAccountStatus` | `GET /accounts/{id}`: a source in `CREDENTIALS` is `credentials_required`; every source `OK` or `CONNECTING` is `connected`; anything else `error`; another provider's account `linkedin_not_found` |
| `listPostEngagers` | `GET /posts/{the id in the URL}` once for the post's `social_id`, then `GET /posts/{social_id}/reactions` and `/comments?sort_by=MOST_RECENT`, merged newest first (below) |
| `getProfile` | `GET /users/{the public identifier of /in/…}?linkedin_sections=experience&notify=false`: the current job gives `title`, `companyName`, `companyUrl` and `industry`; no profile view is notified |
| `parseWebhook` | the account-status webhook and the hosted-auth notify, behind the secret header ("Webhooks") |

**Post links.** `listPostEngagers` reads the six forms signals accepts (`post-url.ts` of its `post_engagers` source, the patterns copied in `constants.ts`): `/posts/<slug>-<kind>-<id>-<code>` (the slug's last `-<kind>-<id>-`) and `/feed/update/urn:li:<kind>:<id>` (each colon plain or `%3A`), `<kind>` `activity`, `share` or `ugcPost`. It asks Unipile for an activity by its number, as before, since a run's cursor keeps it; for a share as `urn:li:share:<id>`, its number being a 404 there; for a ugcPost as `urn:li:ugcPost:<id>`. Any other link is `linkedin_not_found`, with nothing sent.

**Vendor and terms.** Unipile, under the account the key belongs to: the owner's in development and on Whytide Cloud, an operator's own on a self-hosted Core. Hosted authentication only: the user connects their own account on Unipile's hosted page, the link hides its cookie option (`cookie_auth`), and no password, cookie or second factor reaches us. The reads are the plan's: a post's engagers and business profile fields, inside the daily cap and the working hours of alpha-p7-040. Unipile advises about 100 profiles per account and day, and 100 a day for the other routes; past LinkedIn's limits it answers 429 or 500 ([provider limits](https://developer.unipile.com/docs/provider-limits-and-restrictions)). Data processing and retention terms: to be read in the account's agreement; where it is kept: not recorded yet.

**Variables** (`deploy/.env.example`); `requires` names the first three, so the contract suite skips while one is empty:

| Variable | |
|---|---|
| `UNIPILE_BASE_URL` | the account's API address, `https://apiN.unipile.com:PORT`, from Unipile's dashboard; https only |
| `UNIPILE_API_KEY` (secret) | sent as `X-API-KEY`; read once when the adapter starts, never logged |
| `UNIPILE_WEBHOOK_SECRET` (secret) | at least 32 characters (`openssl rand -hex 32`), the `Unipile-Auth` header of the webhook below |
| `UNIPILE_NOTIFY_URL` | the public URL of `POST /v1/linkedin/webhooks/unipile` (alpha-p7-030); `createHostedAuthLink` fails with `config_invalid` without it |

Rotating the key: create a key in Unipile's dashboard, set it, restart the api and the worker, then revoke the old key. Rotating the secret: set the new value on the webhook (or register a new one and delete the old), set `UNIPILE_WEBHOOK_SECRET`, restart; meanwhile webhooks are refused (401) and Unipile retries each five times.

**Webhooks.** Registered by hand, once per Unipile account: `POST /api/v1/webhooks` with `{ "source": "account_status", "request_url": "<UNIPILE_NOTIFY_URL>", "format": "json", "events": ["creation_success", "reconnected", "credentials", "deleted"], "headers": [{ "key": "Unipile-Auth", "value": "<UNIPILE_WEBHOOK_SECRET>" }] }`. `parseWebhook` compares `Unipile-Auth` with the secret before it reads the body, in constant time (both hashed with SHA-256, so the length does not leak); a wrong or missing secret is `linkedin_webhook_invalid`, whatever the body. Then `{ "AccountStatus": { account_id, account_type: "LINKEDIN", message } }`: `CREATION_SUCCESS` and `RECONNECTED` are `account.connected`, `CREDENTIALS` `account.credentials_required`, `DELETED` `account.disconnected`, any other message refused. The hosted-auth notify, `{ status, account_id, name }`, is `account.connected` with `providerRef: name`, but under the same rule: Unipile documents it with no header and no signature, so as documented it is refused, and an unsigned or forged notify never connects an account. The account-status webhook gives `account.connected` without `providerRef`: whether the notify can carry the secret is to be checked on the sandbox.

**Network.** One HTTPS request per call, from the process that makes it (the api for links and webhooks, the worker for reads), to `UNIPILE_BASE_URL` only, with `fetch` rather than the egress client, as docs/rules/security.md §5 allows inside a vendor adapter; 30 seconds at most, redirects never followed (`redirect: "manual"`), so that the key never follows one: a 3xx is `linkedin_provider_error` with its `status` and `reason: "redirect"`, its `Location` neither logged nor kept. A request that fails before any answer is `reason: "unreachable"` with the network error's code when Node gives one in that short upper-case form (`code`: `ECONNREFUSED`, `ECONNRESET`, `UND_ERR_SOCKET`), never its message; past the 30 seconds `reason: "timeout"`. Out go the key, the account id, a post's id or a profile's public identifier, and for a link our return URLs and `UNIPILE_NOTIFY_URL`; back come the hosted URL, the account's sources, a post's reactions and comments with their authors' public fields, a profile with its contact info: only the port's business fields leave this folder. Nothing here logs or opens a span, and `fetch` is not instrumented (the platform's telemetry turns undici off).

**Provider refs.** None stored here. The account id is the port's `providerAccountRef`, which alpha-p7-030 keeps encrypted; a link's `providerRef` is the `name` Unipile echoes.

**Known differences.**
- A reaction has no date at Unipile: its `engagedAt` is the start of the listing, carried by the cursor, so a post's reactions come back on every listing above the comments written before it; a comment's `engagedAt` is its `date`, or the listing's start when that does not parse.
- Every reaction kind is `like`; reposts and replies to comments are not read. An engager the port cannot hold, an out-of-network member with no profile URL, is dropped.
- A 429 is `linkedin_rate_limited` with Retry-After's seconds (60 when it gives none); a 404 `linkedin_not_found`; the error types `errors/disconnected_account`, `errors/expired_credentials` and `errors/checkpoint_error` `linkedin_account_disconnected`; anything else, a redirect, a timeout and an unreachable host `linkedin_provider_error`, with `{ method, status, type }`, `{ method, status, reason }` or `{ method, reason, code }`, never the body.
- A link also expires at Unipile's daily restart, whatever `expiresAt` says.
- The shapes are the documentation's as read on 2026-10-22 (developer.unipile.com): the comment's date format, the error types and the notify's headers are to be verified on the sandbox.

**Sandbox.** In the environment, not `.env.local`: the three required variables; then connect a LinkedIn account by hand in the sandbox, and name a post it can read, `UNIPILE_TEST_POST_URL`, with at least five engagers (the suite reads it over three pages), and a profile, `UNIPILE_TEST_PROFILE_URL`. `pnpm -F providers test:contract` then runs the live suite.

**Tests.** `tests/contract.test.ts` is the port's suite on the sandbox, skipped without the variables. `tests/mapping.test.ts` runs offline on the synthetic fixtures of `tests/fixtures/`, served on 127.0.0.1: the profile without its contact info, the merge with its cursor and without the authors' contact data, the id asked for each form of post link, the link and the status, the webhook secret, and the errors, with no key or body in an error or a log line.
