# email

A member's own work mailbox at Google or Microsoft, connected through OAuth with PKCE (gamma-p1-010, F11 §4.1): the member sees it connected, disconnects it and reconnects it. Its tokens are sealed at rest and opened only in the worker, and the PKCE verifier is never stored. A disconnect revokes the tokens and deletes them; a token the provider revoked disconnects the mailbox. It is the gamma module for mailboxes and email safety: the domain checks, the caps, the stops and the health come with their tasks.

- **Owns:** `sending_domains`, `mailboxes` and `mailbox_connects` ([docs/data.md](docs/data.md)); the events `email.mailbox_connected` and `email.mailbox_disconnected`; the workflow `email_revoke_mailbox`; the routes under `/v1/workspaces/{workspaceId}/email`; the "Mailboxes" screen and the callback page.
- **Public interface:** `index.ts` (below).
- **Depends on:** `platform` (`encryptSecret`, `deriveSecret`; `decryptSecret` in `workflows/` only), `db`, `providers` (the mailbox port), `tenancy` (`findWorkspace`, `findUser`), `ui` for the screens.
- **Reviewers:** the owners of this module. A change to the tokens, the state or the verifier takes two reviews ([security §8](../../../docs/rules/security.md#8-conduct)).

## Public interface

| Export | What it does |
|---|---|
| `disconnectMailbox({ workspaceId, mailboxId, reason, at })` | The one disconnect, in the caller's tenant run: a connected mailbox turns `disconnected` with `user`, `token_revoked` or `member_removed`, and `email.mailbox_disconnected` is published; `{ disconnected }`. |
| `markTokenRevoked(mailboxId, at, { connectedAt? })` | The disconnect with `token_revoked` and the blob nulled at once, for the send and the poller; with `connectedAt`, only that connection's. |
| `findMailbox(mailboxId)` | A mailbox of the run's workspace, never its tokens, or null. |

Also the types `Mailbox`, `DisconnectReason`, `MailboxTokens` and `TokensAnswer` (the worker's `withMailboxTokens`), `CONNECT_STATE_TTL_MS` (10 minutes), `FREE_CONSUMER_DOMAINS`, `events`, `ids` (`dom`, `mbx`, `mcn`), `errors`, `permissions` (`email.read`, `email.connect`, `email.manage`) and `api`.

## API

Under `/v1/workspaces/{workspaceId}/email`. Each route declares an action every role holds; the module checks the row's owner.

- `POST /mailboxes/connect` `{ provider, timeZone }` (`email.connect`): `{ url }`, the provider's consent address. `mailbox_exists` (409), `mailbox_time_zone_invalid` (400).
- `POST /mailboxes/callback` `{ state, code }` (`email.connect`, own runs): the mailbox, connected. `connect_state_invalid` (400), `mailbox_consent_incomplete` (400), `mailbox_in_use` (409), `mailbox_exists` (409), `mailbox_connect_failed` (502).
- `GET /mailboxes` (`email.read`): `{ mailboxes }`, the caller's own, or every mailbox here for a holder of `email.manage`; each with `mine` and `ownerUserId`, never a token.
- `DELETE /mailboxes/{mailboxId}` (`email.connect`): 204, the owner only. `email_mailbox_not_found` (404), `not_mailbox_owner` (403).

## Worker

- `workflows/decrypt.ts`, `withMailboxTokens(context, mailboxId, fn, refresh, narrow?)`: the only place a token is opened. It refreshes an access token within a minute of its expiry first (`refresh`: `"now"` always, `"never"` not), seals a rotated refresh token again, and answers `{ ok: false, reason: "token_revoked" }` after `markTokenRevoked` when the provider answers `mailbox_token_revoked`, never a throw; `no_tokens` for a mailbox with none; `changed` for one that `narrow`, a narrowing of the row read, misses.
- `email_revoke_mailbox`, started by `email.mailbox_disconnected` for `user` and `member_removed`, id `email.revoke:<workspaceId>:<mailboxId>:<disconnected_at>`: `email_revoke_token` (kind `provider`, 5 attempts) revokes, then `email_drop_tokens` (kind `db`) nulls the blob, also once the revoke's attempts ran out, and then logs `email_revoke_failed` (warn). Both do nothing for a mailbox reconnected, or disconnected again, since; the revoke reads the tokens under the same filter, so a reconnect after its check keeps its new grant.

## Screen

"Mailboxes" in the Email group (`ui/mailboxes/`): the connect card (Google, Microsoft and F11 §4.2's recommended setup), the member's mailbox card with Disconnect, a disconnected mailbox's reconnect banner, and a read-only card per teammate's mailbox for a holder of `email.manage`. The callback page `/email/callback` (`ui/callback/`) is outside the workspaces, so the provider's redirect address is fixed; it takes the code off its address before it posts, then opens the mailboxes screen.

## Testing

`pnpm -F email test` (`tests/connect.test.ts`: the state, the verifier, the addresses; `tests/tenancy.test.ts`: the three tables and the address index across workspaces), `test:tenancy`. The routes: `core/apps/api/tests/email-mailboxes.test.ts`; the worker: `core/apps/worker/tests/email-mailbox-check.test.ts`; the screen: `core/apps/web/tests/email-connect.spec.ts`. `@whytide/email/testing`: `createConnectedMailbox(workspaceId, { provider?, address?, timeZone?, ownerUserId?, accessExpiresAt? })` writes a connected mailbox on the mailbox fake's real tokens; `useEmailClient`, `useClock`, `useRandom` and `useSecretKeys` set what the module runs on.

## Decided here

- The claim is one update of the connect row that is unused, unexpired and the caller's: an unknown, used, expired or another member's state is the same `connect_state_invalid`. A claimed row stays used when the exchange then fails: the member connects again.
- An exchange that fails is `mailbox_connect_failed` with the port's code as `details.reason`, never its message. The revoke after `mailbox_consent_incomplete` ignores its own failure.
- The display name is the member's name at the connect, else the address's part before the @.
- The revoke is two activities, so the drop has its own attempts once the revoke's ran out; each checks the mailbox is still disconnected at the run's `disconnected_at`.
- A `token_revoked` disconnect starts no revoke: the grant is gone and the blob is null already.
- `markTokenRevoked` from the worker and the re-seal after a refresh change only the connection the tokens came from (`connected_at`): a mailbox reconnected meanwhile keeps its new tokens.
- The refresh margin, 60 seconds (`ACCESS_MARGIN_MS`), and `FREE_CONSUMER_DOMAINS`' 22 public providers beyond the two RB-12.1.2 names: not in the sources.
- Until gamma-p6-010 evaluates roles, `can()` allows every member, so every member's list holds every mailbox of the workspace, read-only and without tokens.
- The hourly check and the owner's mail on a revoked token are gamma-p1-015's (the diff's size): until then a revoked token is found by a later task's send or read.
- Used connect rows stay: no retention yet.
