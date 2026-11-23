# The mailbox port

A member's own Google or Microsoft mailbox, connected by OAuth and nothing else (F11 §4.1 and §6, briefs RB-12.1.1, RB-12.3.4; [architecture §9](../../../../docs/architecture.md#9-ports-and-adapters)): the port connects it, keeps its access fresh, sends one finished message under the platform's own Message-ID, finds a sent message by it, reads what is new in the platform's own threads since a cursor, and reads one of those threads. Eight methods, nothing more ("What the port will never have"). Email ships closed: nothing in the port opens sending.

```ts
import { getAdapter, mailboxAdapterFor, mailboxPort } from "@whytide/providers";

const mailbox = await getAdapter(mailboxPort, mailboxAdapterFor(sender.provider)); // google or microsoft
```

| Method | Takes | Gives |
|---|---|---|
| `createAuthUrl` | `redirectUri`, `state`, `codeChallenge` (PKCE S256: `codeChallengeFor(newCodeVerifier())`), `loginHint?` | `url`, the consent page |
| `exchangeCode` | `code`, `redirectUri`, `codeVerifier` | `address` (lower case; null when the grant does not show it), `refreshToken`, `accessToken`, `accessExpiresAt`, `scopes` (what the person granted, in the port's words: `send`, `read`) |
| `refreshAccess` | `refreshToken` | `accessToken`, `accessExpiresAt`, `refreshToken?` (a rotated one, which the caller stores) |
| `revokeAccess` | `refreshToken` | `revoked` (false where the provider cannot revoke one grant) |
| `sendMessage` | `accessToken`, `raw`, `messageId`, `threadRef?`, `idempotencyKey` | `messageId` (as the provider kept it), `messageRef` and `threadRef` (null while the provider does not show the message yet), `sentAt` |
| `findSent` | `accessToken`, `messageId` | `{ found: true, messageRef, threadRef, sentAt }` or `{ found: false }` |
| `listNewMessages` | `accessToken`, `address` (the mailbox's own), `cursor` (null the first time), `match` (`threadRefs`, `messageIds`, `unsubscribeSubjectPrefix?`, at most `MAILBOX_MATCH_MAX` each), `limit` (1 to `MAILBOX_LIST_LIMIT_MAX`) | `events`, `cursor`, `more`; a null cursor answers the current cursor and no event, whatever the mailbox holds |
| `readThread` | `accessToken`, `address`, `threadRef`, `limit` | `events`: the thread's newest `limit` messages, in date order; `more`: older ones were left out |

Every input is an exact object: another key is `mailbox_input_invalid`. Refs and cursors are opaque, stored as they come (Gmail's history id, Graph's delta links). The port does not judge the grants: gamma-p1-010 refuses a connection without both scopes and revokes it. The outputs are strict and checked in every environment, production included (`alwaysCheckOutputs`, [../README.md](../README.md) "The boundary"). `PROVIDER_MAILBOX` (`config.ts`): set, the one adapter every mailbox uses, `fake` in development and tests; empty, each mailbox its provider's, which `mailboxAdapterFor(provider)` answers; any other name fails `getAdapter` at start. A test script that loads `.env.local` sets `PROVIDER_MAILBOX=fake`, as the api's sets `PROVIDER_LINKEDIN=fake`.

## Events

`listNewMessages` and `readThread` answer `MailboxEvent`s, keyed by `kind`, each with `messageRef`, `threadRef` and `at`, the provider's time of the message:

| `kind` | Fields | Is |
|---|---|---|
| `reply` | `messageId`, `inReplyTo`, `fromAddress`, `subject`, `text` | a message from another address in a matched thread, or naming a matched Message-ID in `In-Reply-To` or `References`; `inReplyTo` is the platform Message-ID the reply answers, the one the caller finds its send by: the matched one in `In-Reply-To`, else in `References`, else `In-Reply-To`'s first; `text` is the first text/plain part, at most `MAILBOX_TEXT_MAX_CHARS` (20,000) characters, no attachment, no HTML; a field that does not read is null |
| `sent` | `messageId`, `subject`, `text` | the mailbox's own message in a matched thread, or under a matched Message-ID: the platform's, or one the member typed in the mail program |
| `bounce` | `originalMessageId`, `permanent`, `status` | a delivery report (RFC 3464) of a failed delivery naming a matched Message-ID; `permanent` for a 5.x.x status, `5.0.0` when none reads; no recipient address, no text |
| `complaint` | `originalMessageId`, `feedbackType` | a feedback report (RFC 5965) naming a matched Message-ID; `other` when no type reads |
| `unsubscribe_request` | `subject` | a message to the mailbox whose subject starts with `unsubscribeSubjectPrefix` (`listNewMessages` only) |

A revoked grant is the code `mailbox_token_revoked` on any call, not an event: neither provider tells a polling client any other way. Subjects, texts and addresses are personal data: never in a log line, an error's `details` or a metric label.

## The match

`match.ts` is the one rule, inside every adapter, so that no module ever sees a personal message. An adapter reads a new message's head first, `headOf`: its refs, its time and the six `HEAD_FIELDS` (`Message-ID`, `In-Reply-To`, `References`, `From`, `Subject`, `Content-Type`), which it asks the provider for before the body; `headOf` lower-cases their names and trims their values, so a leading space or fold hides no prefix. It asks the call's `mailboxMatcher` whether the message may give an event (`mayMatch`), reads the whole message only then, and returns only what `eventOf` gives. In order:

1. a `multipart/report` is read as a report, never as a reply, and gives an event only when it names a matched Message-ID: a bounce for a failed delivery, a complaint for a feedback report;
2. the mailbox's own message is `sent`, in a matched thread or under a matched Message-ID;
3. another address's message is an unsubscribe mail when its subject starts with `unsubscribeSubjectPrefix`, in a matched thread too;
4. otherwise it is a reply, in a matched thread or naming a matched Message-ID anywhere in `In-Reply-To` or `References`.

A message outside the match leaves no trace: no event, no log line, no metric label. A platform thread is one whose earliest message was sent from `address` under a Message-ID of the platform's form (`isPlatformThread`); `readThread` answers no other, an unknown ref included (`mailbox_not_found`, nothing of it returned), and reads the thread's newest `limit` messages in date order through the rule, that thread and its platform Message-IDs as the match (`platformThread`).

`reports.ts` reads a report (RFC 6522): a delivery status notification (RFC 3464, and RFC 6533's global one) or a feedback report (RFC 5965). It gives the original Message-ID, from the returned message or its headers, else from `X-Original-Message-ID` or `In-Reply-To`; for a delivery, the action and status of the first failed recipient, `5.0.0`, so permanent, for a failed one without a readable status; for a feedback report, its type, `other` when none reads. It reads no recipient address and no text.

`mime.ts` reads the body: the content type and its multipart parts, the subject's encoded words (RFC 2047), and quoted-printable and base64 bodies in their charset; a charset the runtime's `TextDecoder` lacks reads as UTF-8. A text is the first `text/plain` part that is not an attachment, the parts of a multipart searched in order, never HTML, with LF line ends and at most `MAILBOX_TEXT_MAX_CHARS` code points.

The reading is pure, strings in and facts out, with no dependency. A message it cannot read gives no event, or a reply without its text, and never an error. It reads at most a message's first MiB (`READ_MAX_CHARS`) and a field's first 16 KiB (`FIELD_READ_MAX_CHARS`; a longer address is not read) before any regular expression, and each of those reads in linear time.

## Sending once

`messageIdFor({ idempotencyKey, domain })` is the platform's Message-ID: `wt-` (`MAILBOX_MESSAGE_ID_PREFIX`), the SHA-256 of the step's key, at the sender's domain; one key always gives one Message-ID, and the key never reaches the recipient. Every raw message passes `raw.ts` before any call: CRLF line ends, at most `MAILBOX_RAW_MAX_BYTES` (512 KiB), exactly one `Message-ID` equal to `messageId` and of the platform's form, exactly one `To` of at most 998 characters with one address, no `Cc`, no `Bcc`, no `Resent-` recipient; a failure is `mailbox_input_invalid` naming the field, never a value, and nothing is called. Gmail and Graph take no idempotency key: the port carries `idempotencyKey` and relies on nothing. The one-send guarantee is the caller's reservation and `findSent` before any retry (gamma-p1-070); after `mailbox_provider_error` on a send the outcome is unknown, and `found: false` within `MAILBOX_FIND_SETTLE_SECONDS` (120) of the attempt proves nothing: the provider may not have indexed it yet.

## Codes

| Code | When |
|---|---|
| `mailbox_token_revoked` (401) | the grant is gone: revoked by the person or an admin, expired, the password changed |
| `mailbox_access_expired` (401) | the access token is no longer valid: refresh, then call again |
| `mailbox_scope_missing` (403) | a call the grant does not cover, such as a send after the person withdrew sending |
| `mailbox_rate_limited` (429) | the provider's rate limit; `details.retryAfterSec` |
| `mailbox_quota_reached` (429) | the provider's daily sending limit for the mailbox; `details.retryAfterSec` when known |
| `mailbox_send_refused` (422) | the provider refused this message for good |
| `mailbox_not_found` (404) | a thread or message the provider does not know, or a thread the platform did not start (`readThread`) |
| `mailbox_cursor_invalid` (410) | the provider no longer knows the cursor: start again with none |
| `mailbox_provider_error` (502) | anything else, `details.status` only; after a send, the outcome is unknown |
| `mailbox_input_invalid`, `mailbox_output_invalid`, `mailbox_error_unmapped` | the pattern's own ([../README.md](../README.md) "The boundary") |

Developer-facing: no message keys; the email module maps the codes (gamma-p1-010).

## What the port will never have

A method that lists, searches or reads a mailbox outside the match; a folder or label listing; a send to more than one recipient; deleting or moving mail; a password: OAuth only. `readThread` is no way around it: it refuses every thread the platform did not start. No method name, lower-cased, holds `search`, `delete`, `trash`, `move`, `label`, `folder` or `forward`: `../tests/safety/mailbox-platform-threads-only.test.ts` checks it in the types and at run time, and the shape check refuses an adapter's extra method. Push (Gmail's watch, Graph's subscriptions), attachments and HTML bodies are out: polling every five minutes is enough at gamma's volume.

## Adapters

| `PROVIDER_MAILBOX` | |
|---|---|
| `fake` | in memory, the default in `deploy/.env.example` |

## The fake

Grants, tokens and mailboxes in memory. Every message, sent or played, is kept as raw text and read through `match.ts` as an adapter reads one, its head from its `HEAD_FIELDS` first, so the fake answers only what the match accepts, with subjects and texts decoded. A consent connects `member@fake-mailbox.example` with both scopes unless `consentNext` says otherwise; `createAuthUrl` answers the `redirectUri` itself with a `code` and the `state` in its query, so a test's browser lands on the callback without a consent page; `exchangeCode` refuses an unknown or used code, another `redirectUri` or a wrong verifier (`mailbox_input_invalid`); `refreshAccess` rotates the refresh token, the old one then `mailbox_token_revoked`. An unknown access token is `mailbox_access_expired`, a call outside the grant's scopes `mailbox_scope_missing` (a send needs `send`, the reads `read`), a cursor it did not give `mailbox_cursor_invalid`; `limit` counts the messages read, the match's or not. It **ignores `idempotencyKey`** and records every call: two sends with one key are two messages under one Message-ID (`../tests/safety/mailbox-idempotency.test.ts`). It never logs, and its `create()` refuses `APP_ENV=production` with `adapter_invalid`. Module tests reach it as `(await getAdapter(mailboxPort, "fake")) as unknown as MailboxFake`; beside `recordedCalls`, `failNext` (`mailbox_rate_limited` carries `retryAfterSec: 60`), `answerNext` and `reset()`:

| Helper | Does |
|---|---|
| `consentNext({ address?, scopes? })` | what the next `exchangeCode` grants: an address, lower-cased, or null for a grant that does not show it; the scopes, `["send"]` for a consent without reading |
| `playReply({ inReplyTo, from?, subject?, text? })` | a reply to the message under `inReplyTo`, in its thread, from its recipient unless `from` |
| `playSent({ threadRef?, messageId?, to?, subject?, text? })` | the mailbox's own message, typed in the mail program: in the thread given or a new one; a new thread under a platform Message-ID is a platform thread |
| `playBounce({ originalMessageId, status?, action? })`, `playComplaint({ originalMessageId, feedbackType? })` | a delivery report (`5.1.1`, `failed`) or a feedback report (`abuse`), in the original's thread when the fake holds it |
| `playUnsubscribe({ subject, from? })` | a mail to the mailbox under the subject, as a `mailto:` unsubscribe link sends one |
| `playPersonal({ from?, subject?, text? })` | a message outside every platform thread, in a thread of its own |
| `revoke()` | every grant so far is gone: their later calls answer `mailbox_token_revoked`; a new consent makes a new grant |
| `failAfterSendNext(code, details?)` | the next send is kept and findable, then answers the code |
| `findMissesNext()` | the next `findSent` answers `found: false`, as before the provider indexed the send |

Each play helper returns `{ messageRef, threadRef, messageId }`.

## The contract suite

`contract.ts` holds `mailboxCases(world)`. A `MailboxWorld` is the adapter's side: `connect(mailbox)`, a connection for each case (the fake's consent, `connectByConsent`; a live world's own grant), `recipient`, a mailbox of the tester's own, `settleSeconds` before `findSent` (`MAILBOX_FIND_SETTLE_SECONDS` live), and `fake`, the helpers. On a live adapter the suite sends one message to the recipient, finds it by its Message-ID after the settle time, reads back its own thread with its `sent` event, and reads an invented thread ref as `mailbox_not_found`; the cases that need a reply, a bounce, a complaint, an unsubscribe mail, a personal thread, a scope, a revoke or an injected code run on the fake only. It runs on the fake from `fake/tests/contract.test.ts`, with the fake's own tests, and through the registry from `tests/contract.test.ts`, with the port's: `PROVIDER_MAILBOX`, the codes table, `messageIdFor` and the exact key sets. `tests/match.test.ts`, `tests/reports.test.ts` (synthetic reports in Google's and Microsoft's shapes) and `tests/raw.test.ts` hold the rule with the body reading, the reports and the raw checks (`pnpm -F providers test:contract`); the safety cases are `../tests/safety/mailbox-*.test.ts` (`pnpm -F providers test:safety`).
