# email: flows

## Connect

1. The screen posts `POST /mailboxes/connect { provider, timeZone }`. In the request's run: no connected mailbox of the member's here, then a connect row with the hash of the state `<workspaceId>.<nonce>`, expiring in 10 minutes. The port's `createAuthUrl` gets the state and the S256 challenge of the verifier `deriveSecret(state, { purpose: "email.pkce_verifier" })`; the browser goes to the `url` it answers.
2. The provider sends the browser to `/email/callback` with `code` and `state`, or `error`. The page replaces its address, then posts `POST /mailboxes/callback { state, code }` to the state's workspace.
3. The callback, in runs of its own: it claims the row (unused, unexpired, the member's), calls `exchangeCode` with the verifier derived again, outside any run, then in a new run finds or makes the domain, writes or reuses the mailbox row with the sealed tokens and publishes `email.mailbox_connected`. The page opens `/w/<workspace>/mailboxes`.

## Disconnect

`DELETE /mailboxes/{mailboxId}` by the owner, or `disconnectMailbox` for a removed member: the row turns `disconnected` with its reason and time, and `email.mailbox_disconnected` goes to the outbox. Its subscriber starts `email_revoke_mailbox` (`email.revoke:<workspaceId>:<mailboxId>:<disconnected_at>`): the revoke at the provider, then the blob nulled; both are skipped for a mailbox reconnected, or disconnected again, since.

## Reconnect

The connect again, from the banner: the same address's row turns `connected` with its new tokens and keeps its id.

## Revoked token

A worker call through `withMailboxTokens` that meets `mailbox_token_revoked`: `markTokenRevoked` disconnects the mailbox with `token_revoked` and nulls the blob at once, for the connection the tokens came from only; its event starts no revoke. The hourly check and the owner's mail come with gamma-p1-015.
