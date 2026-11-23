# email: runbook

## A mailbox that will not connect

- `connect_state_invalid`: the consent took more than 10 minutes, the callback was opened twice, or another member's or workspace's link was used. Connect again.
- `mailbox_consent_incomplete`: the member left sending or reading unticked on the consent screen, or the account showed no address. Connect again and grant both.
- `mailbox_in_use`: the address is connected in another workspace, or is another member's here. Disconnect it there first.
- `mailbox_connect_failed` (502): the code exchange failed; `details.reason` is the port's code. A master key rotation between the connect and the callback fails that one connect too. Connect again; when it repeats, check the OAuth app's redirect address, `${APP_PUBLIC_ORIGIN}/email/callback`.
- "APP_PUBLIC_ORIGIN is not set" (500): the api has no origin for the redirect address; on a laptop it takes `WEB_DEV_ORIGIN`.

## A revoke that failed

`email_revoke_failed` (warn, with `mailbox_id`): the provider refused the revoke five times; the tokens are deleted all the same. The grant ends when the member removes the app from their Google or Microsoft account, or when its refresh token expires.
