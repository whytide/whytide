# email: data

Three workspace tables in `core/packages/db/prisma/schema/email.prisma` (migration `20261101163425_email_mailboxes`), each with `workspace_id`. None holds a `person_id`, so there is no eraser.

| Table | Prefix | What it holds |
|---|---|---|
| `sending_domains` | `dom_` | One row per workspace and domain, in lower case. |
| `mailboxes` | `mbx_` | The owner, the domain, the provider, the address (lower case), the display name, the scopes, `oauth_token_ref` (the sealed `{ refreshToken, accessToken, expiresAt }`, null once revoked), `is_free_consumer`, `status`, `disconnected_reason` and `disconnected_at` (set exactly while disconnected), `time_zone`, `connected_at`, `token_checked_at`. |
| `mailbox_connects` | `mcn_` | A connect: the member, the provider, the time zone, `state_hash` (the SHA-256 of the state's nonce), `expires_at`, `used_at`. Never the state, the code or the verifier. |

Hand-written in the migration: the CHECK `mailboxes_status_columns` (the reason and the time exactly while disconnected; a connected mailbox holds tokens), `mailboxes_owner_connected` (one connected mailbox per member and workspace) and `mailboxes_address_connected` (one connected mailbox per address, across workspaces). The address and the display name are the member's business contact (`pii: business_contact`). A disconnected mailbox's row stays, its tokens null once the worker revoked them; used connect rows stay too (no retention yet).
