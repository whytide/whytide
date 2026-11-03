# The LinkedIn port

Every LinkedIn call of the product goes through this port: the user's own account, connected through the vendor's hosted authentication, then reads within the cap ([security §1](../../../../docs/rules/security.md#1-red-lines), [architecture §9](../../../../docs/architecture.md#9-ports-and-adapters)). Eleven methods: alpha's five on the read side, and beta's six on the send side ("Sending"). The port sends: nothing calls a send method without a reservation (the linkedin module's rule, from beta-p1-030).

```ts
import { getAdapter, linkedinConfig, linkedinPort } from "@whytide/providers";

const linkedin = await getAdapter(linkedinPort, linkedinConfig.PROVIDER_LINKEDIN); // at start
const { url, providerRef } = await linkedin.createHostedAuthLink({ successUrl, failureUrl, expiresInMin: 30 });
```

| Method | Takes | Gives |
|---|---|---|
| `createHostedAuthLink` | `successUrl`, `failureUrl`, `expiresInMin` (1 to 1,440) | `HostedAuthLink { url, expiresAt, providerRef }`: send the browser to `url`; keep `providerRef` with the pending connection |
| `getAccountStatus` | `providerAccountRef` | `AccountStatus { status, checkedAt, memberRef }`, `status` one of `connected`, `disconnected`, `credentials_required`, `error`; `memberRef` the account's own member id, or null where the vendor gives none ("Events") |
| `listPostEngagers` | `providerAccountRef`, `postUrl`, `cursor?`, `limit` (1 to 100) | `{ engagers: Engager[], nextCursor }`, newest first by `engagedAt` across pages (a caller stops at its watermark), `nextCursor` null on the last page; a cursor reads the same page again |
| `getProfile` | `providerAccountRef`, `profileUrl` | `Profile` |
| `parseWebhook` | `{ headers, rawBody }`, the request as received, the body's raw bytes or their text | `LinkedinWebhookEvent`, keyed by `kind`: alpha's `account.connected` (with the link's `providerRef` on a pairing), `account.disconnected` and `account.credentials_required`, then `account.status`, `invite.accepted`, `message.received` and `ignored` ("Events") |
| `sendInvite` | `providerAccountRef`, `memberRef`, `note?` (at most 300 characters), `idempotencyKey` | `SentInvite { invitationRef, sentAt }` |
| `sendMessage` | `providerAccountRef`, `memberRef`, `chatRef?`, `text` (1 to 1,900 characters), `idempotencyKey` | `SentMessage { messageRef, chatRef, sentAt }`: in the chat given, else the member's own, found or opened |
| `withdrawInvite` | `providerAccountRef`, `invitationRef` | `{ withdrawnAt }` |
| `listPendingInvites` | `providerAccountRef`, `cursor?` | `{ invites: PendingInvite[], nextCursor }`, `PendingInvite { invitationRef, memberRef, sentAt }`, `nextCursor` null on the last page |
| `listRecentMessages` | `providerAccountRef`, `memberRef`, `chatRef?`, `since` | `{ messages: RecentMessage[] }`, `RecentMessage { messageRef, chatRef, fromAccount, sentAt }`: refs and times only, never text |
| `getRelation` | `providerAccountRef`, `memberRef` | `LinkedinRelation { connected, invitationPending }` |

Every ref is opaque, 1 to 256 characters, never parsed; a cursor at most 2,048; an instant a `Date`. `postUrl` and `profileUrl` are https URLs on `linkedin.com`. `parseWebhook` checks the vendor's signature before it reads the body, in constant time, with a secret from the adapter's config that nothing logs; `PROVIDER_LINKEDIN` (`config.ts`) names the adapter.

## Profiles and engagers

`Profile { providerMemberRef, profileUrl, firstName, lastName, headline, title, companyName, companyUrl?, locationText, industry?, fetchedAt }` and `Engager { providerMemberRef, profileUrl, name, headline, reaction, commentText?, engagedAt }` hold business fields only. `linkedinProfile` and `linkedinEngager` are their schemas: parsing drops every other key, so an adapter returns `linkedinProfile.parse(mapped)` and a vendor's email, phone or photo stops there. The method outputs are strict, and the port is defined with `alwaysCheckOutputs`: the boundary checks its outputs in every environment, production included, so an adapter that forgets the parse fails `linkedin_output_invalid` rather than pass a vendor's field on ([../README.md](../README.md) "The boundary"). `tests/contract.test.ts` asserts the exact key sets of `Profile`, `Engager` and the six send-side outputs. Names and headlines are personal data: never log them.

## Sending

`sendInvite` and `sendMessage` send from the user's own account; `withdrawInvite` takes an invitation back; `listPendingInvites`, `listRecentMessages` and `getRelation` read. `listRecentMessages` and `getRelation` are the checks before a send: their callers reserve them as reads, and they count in the account's 200 actions a day.

- **Ceilings, not limits.** A note is at most 300 characters and a message 1 to 1,900 (briefs RB-11.2.5, RB-9.1.2; `constants.ts`): bounds that keep a vendor call sane. The caller's own limits are lower, messaging's `LINKEDIN_NOTE_LIMIT` for a note.
- **The idempotency key.** Each send carries its step's key (RB-1.2.4, 1 to 128 characters), so an adapter that honors one can use it. Unipile does not, and the fake ignores it too: the one-send guarantee never rests on the adapter, but on the caller's reservation and its check before a retry (beta-p1-030, beta-p1-050). After `linkedin_provider_error` a send's outcome is unknown: the caller checks with the reads before any retry.
- **No message text on the way back.** `listRecentMessages` answers refs, the sender side and times: the check before a message moves no text. `chatRef` lets a caller that knows the chat skip the lookup.
- **One id form.** `memberRef` is the same id as `getProfile`'s `providerMemberRef`, opaque.

## Codes

| Code | When |
|---|---|
| `linkedin_rate_limited` (429) | the vendor's rate limit; `details.retryAfterSec` is the wait in seconds |
| `linkedin_limit_reached` (429) | LinkedIn's own limit, such as the weekly invitation limit; not the vendor's rate limit |
| `linkedin_send_refused` (422) | a permanent refusal of a send: already invited, already connected, not connected for a message, the recipient unavailable |
| `linkedin_account_disconnected` (409) | the account is not connected; `details.reason`, when the adapter knows it, one of `LINKEDIN_DISCONNECT_REASONS`: `credentials_required`, `checkpoint`, `restricted`, `disconnected` (optional, so alpha's callers, which read the code, keep working) |
| `linkedin_not_found` (404) | no such account, post or profile, or none the account can see |
| `linkedin_webhook_invalid` (401) | a webhook whose signature does not match, or whose body is not the vendor's |
| `linkedin_provider_error` (502) | anything else the vendor answered: `details.status`, never its body; after a send, the temporary error that leaves the outcome unknown |
| `linkedin_input_invalid`, `linkedin_output_invalid`, `linkedin_error_unmapped` | the pattern's own ([../README.md](../README.md) "The boundary") |

Developer-facing: no message keys.

## What the port will never have

A password, a cookie or a second-factor secret; a shared, rented or fake account; scraping. A profile's contact info (email, phone, address), its photo, birthday or pronouns, a special-category field or anything a visibility setting hides: no type here can carry them, and a test fails on the first of them added. Likes, comments, reshares, endorsements, InMail and "Contact info", in any version (briefs RB-9.1.3; the beta's rules we keep): no method name, lower-cased, holds `like`, `comment`, `reshare`, `repost`, `endorse`, `inmail` or `contactinfo`. `tests/contract.test.ts` checks it in the types, `../tests/safety/port-never-list.test.ts` in the types and at run time, and the shape check refuses an adapter's extra method. Profile views, following, company pages, the inbox: later versions, each as a new method.

## Adapters

| `PROVIDER_LINKEDIN` | |
|---|---|
| `fake` | in memory, the default in `deploy/.env.example` (below) |
| `unipile` | Unipile's REST API over `fetch`, no SDK ([unipile/README.md](unipile/README.md)); `unipile-node-sdk` stays listed in `tools/lint/vendor-sdks.json` for `linkedin/unipile/` only |

## The fake

Accounts, posts and profiles in memory, and each account's network: its pending invitations by member, its relations, its chats and their messages as refs and times, never text. Module tests reach it as `(await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake`. Its `create()` refuses `APP_ENV=production` with `adapter_invalid`: the fake never stands in for LinkedIn on a server. Its controls, beside `recordedCalls`, `answerNext` and `reset()`:

| Control | Does |
|---|---|
| `seedPost(postUrl, engagers)` | a post `listPostEngagers` pages newest first by `engagedAt`, ties in the order given; an unseeded post is `linkedin_not_found` |
| `seedProfile(profile)` | a profile `getProfile` returns, `fetchedAt` set at the read |
| `emitWebhook(kind, providerAccountRef)` | alpha's three account kinds: the account takes the kind's status, created if need be, and the signed webhook `{ headers, rawBody }` is returned for the test to deliver; the other kinds have their own helpers ("Events") |
| `connectOnVisit(deliver?)` | a connect-style handler serving `GET /api/linkedin/fake/connect?link=…`, where the fake's hosted links point (on the success URL's origin), under `APP_ENV=test` only: a visit connects a new account, hands its `account.connected` webhook to `deliver` and answers 303 to the success URL; an expired link goes to the failure URL, an unknown or used one to `next()` |
| `acceptInvite(providerAccountRef, memberRef)` | the member accepts the pending invitation: a relation now; none pending is `linkedin_not_found` |
| `seedRelation(providerAccountRef, memberRef)` | the member is a relation already, with no invitation pending |
| `failNext(code, details?)` | the next call throws the code; `linkedin_rate_limited` carries `retryAfterSec: 60` unless `details` give one; `failNext("linkedin_account_disconnected", { reason: "checkpoint" })` reaches the caller with the reason |

Reads and sends need a connected account: an unknown one is `linkedin_not_found`, any other status `linkedin_account_disconnected`, with the status as `details.reason`: `disconnected`, `credentials_required`, `checkpoint` or `restricted`. An invitation to a relation or a pending member, and a message to a member who is not a relation, are `linkedin_send_refused`; `withdrawInvite` of an unknown ref, or a `chatRef` that is not the member's, `linkedin_not_found`. A message without `chatRef` goes to the member's chat, opened on the first. The fake **ignores `idempotencyKey`**, as Unipile does, and has no mode that honors it: it records every call, a repeat with the same key included, so a repeated `sendMessage` is a second message and a repeated `sendInvite` a second call, refused as already invited; a test sees a double send (`../tests/safety/port-idempotency.test.ts`). `listPendingInvites` pages 100 at a time. Its webhooks carry `x-linkedin-fake-signature: sha256=<HMAC-SHA256 of the raw body>`, under `TEST_WEBHOOK_SECRET` with `APP_ENV=test` and a secret drawn at start anywhere else: only its helpers and the route sign one ("Events").

## The contract suite

`contract.ts` holds `linkedinCases(world)`: a hosted link connects the account and its status is `connected`; engagers over three pages with a stable cursor, newest first; a profile; a signed webhook parsed and a forged or unsigned one refused; the rate limit with `retryAfterSec`; `linkedin_not_found` on an unknown post; an invitation sent, pending in `listPendingInvites` and `getRelation`, then withdrawn; a message to a relation, read back by `listRecentMessages` as refs and a time, without its text; a read and a send on a disconnected account, `linkedin_account_disconnected`; for each kind of event, a signed one parsed to its shape and the same one forged or unsigned refused, with nothing of it in the refusal; an event delivered twice under one `eventKey`, two messages under two; `getAccountStatus`'s `memberRef` the same on every call. The `LinkedinWorld` is the adapter's side: how a user connects through a link, a post and a profile the account can read, the vendor's signed and forged webhooks, `rateLimitNext` when the vendor can be made to rate-limit, `recipient(providerAccountRef, { relation? })` for a member to invite or a relation to message, `disconnected()` for a disconnected account's ref, and `event(kind)` for a new signed event of the kind with its forged copy and what it parses to, or undefined for a kind the vendor never sends, whose case skips (Unipile sends no `account.status`); each case skips without its hook. A run sends at most one invitation, withdrawn at once, and one message. The suite runs on the fake from `fake/tests/contract.test.ts` (`pnpm -F providers test:contract`), which seeds ninety engagers, serves the route on a local server and gives every hook; the Unipile world gains the send hooks in beta-p0-030. `tests/contract.test.ts` holds the port's own tests: the eleven methods through the registry, the shape check, the never list in the types, the exact key sets, the profile schema, the lint.

A new method: its schemas in `port.ts`, its case in `contract.ts`, then the fake and every adapter.

## Events

`parseWebhook` checks the vendor's signature in constant time before it reads the body, then gives one event in our words, `LinkedinWebhookEvent`, keyed by `kind`; `LINKEDIN_WEBHOOK_KINDS` lists the kinds. Architecture §13's "verify, answer at once, process later": the port verifies and parses, the receiver answers and hands on (beta-p0-060).

| `kind` | Fields | Says |
|---|---|---|
| `account.connected` | `providerAccountRef`, `providerRef?` | alpha's; `providerRef` on a pairing notify, the link's |
| `account.disconnected`, `account.credentials_required` | `providerAccountRef` | alpha's |
| `account.status` (`AccountStatusEvent`) | `providerAccountRef`, `status` | `status` one of `LINKEDIN_EVENT_STATUSES`: `connected`, `credentials_required`, `checkpoint`, `restricted`, `disconnected`; each but `connected` is a disconnect reason |
| `invite.accepted` (`InviteAccepted`) | `providerAccountRef`, `eventKey`, `memberRef`, `occurredAt?` | a new relation of the account's |
| `message.received` (`MessageReceived`) | `providerAccountRef`, `eventKey`, `chatRef`, `messageRef`, `senderMemberRef`, `fromAccount`, `attendeeMemberRefs` (at most 50), `text` (at most 20,000 characters), `sentAt` | a message in one of the account's chats |
| `ignored` | none | a verified event of a kind the port does not know: a result, not an error, so the provider stops retrying |

- **`eventKey`** is the provider's event or message id, 1 to 256 characters, the same on every redelivery of one event: the receiver de-duplicates the person events on it. Account events carry none: they apply by state, as alpha's do.
- **Which account kind an adapter emits:** `account.connected` with `providerRef` for a pairing notify; alpha's three kinds for connected, disconnected and credentials, so alpha's handler keeps working until beta-p0-060; `account.status` for what alpha's kinds cannot say, `checkpoint` and `restricted`. The receiver reads both forms as one status.
- **`fromAccount`** is true when the account itself sent the message, from Whytide or by hand on LinkedIn. An adapter that cannot tell maps the message as inbound, `false`, so a doubtful message holds a sequence rather than let it go on.
- **One id form:** `memberRef`, `senderMemberRef` and `attendeeMemberRefs` are `getProfile`'s `providerMemberRef` and `sendInvite`'s `memberRef`, so a reply matches the invitation before it.
- **An acceptance counts from its detection** (RB-9.2.2, RB-11.2.4): `occurredAt` is only what the provider says; the receiver stamps the detection time.
- **Message text is personal data:** it is in the parsed output only, never in an error's `details`, a log line or a metric label, nor is a member or a chat ref. A refusal's `details` are `{ method, reason }`; the boundary's issues name a field, never its value. The bounds, not in the sources, are above LinkedIn's own, so that a real message never fails them.
- **The account's own member id:** `getAccountStatus` answers `memberRef`, in the same form, null where the vendor gives none. The fake derives one from the account's ref, `fake-member-self-` and the start of its SHA-256, the same in every process; Unipile answers the account details' `connection_params.im.id`, null without it ([unipile/README.md](unipile/README.md)); beta-p1-070 stores its keyed hash.

The fake's body is JSON whose `type` is the kind (`fake/webhooks.ts`): a signed body of another `type` is `ignored`, one of its types off its format `linkedin_webhook_invalid`. Under `APP_ENV=test` it signs with `TEST_WEBHOOK_SECRET` (`fake/constants.ts`), a fixed test value, so that a webhook a test signs verifies in a separately started api (alpha revisit p7-010); anywhere else with a secret drawn at start, which nothing logs. Each helper takes the account first, changes the fake's state as its event says, and returns the signed `{ headers, rawBody }`:

| Helper | Event | State |
|---|---|---|
| `emitAccountStatus(providerAccountRef, status)` | `account.status`, whatever the status | the account takes it, created if need be; `getAccountStatus` answers `error` for `checkpoint` and `restricted`, as Unipile does for a source neither OK nor CREDENTIALS, and reads and sends refuse with the status as `details.reason` |
| `emitAccepted(providerAccountRef, memberRef)` | `invite.accepted`, a new `eventKey` each time, `occurredAt` now | the pending invitation becomes a relation, as `acceptInvite`'s does; with none pending, a relation all the same, as one accepted by hand is |
| `emitMessage(providerAccountRef, { memberRef, chatRef?, text, fromAccount? })` | `message.received`, its `messageRef` its `eventKey`; the sender the member, or the account's own member id with `fromAccount`; `attendeeMemberRefs` `[memberRef]` | the message joins the chat given, opened under that ref when new, else the member's own, as refs and its time, so `listRecentMessages` reads it; the fake keeps no text |
| `forge(webhook)` | any kind | none: a copy with a wrong signature, the body and the other headers kept |

`fake/tests/events.test.ts` holds the helpers' state changes, `forge`, the test secret across two processes and the log check: a forged, an off-shape and a good message event leave no text, member ref or chat ref in an error, a log line or a metric label. `../tests/safety/webhook-verify.test.ts` holds the safety cases: a forged or unsigned event of every kind is refused for its signature before its body is parsed, a forged body that is not JSON included, and an unknown signed type is `ignored`, never an error.
