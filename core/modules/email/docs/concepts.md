# email: concepts

- **Mailbox:** a member's own work mailbox at Google or Microsoft, connected through OAuth: its address, provider, granted scopes (`send`, `read`), the member's time zone at the connect, and its tokens, sealed. One connected mailbox per member and workspace, and an address connected in one workspace at most.
- **Sending domain:** the part of a mailbox's address after the @, one row per workspace and domain, found or made at the connect. gamma-p1-020 checks it.
- **Free consumer address:** an address at a public provider (`FREE_CONSUMER_DOMAINS`: gmail.com, outlook.com and others). It connects, with `is_free_consumer` true; gamma-p1-020 refuses its cold sends (F11 R2).
- **Connect:** the member's consent at the provider, between the connect route and the callback: a row with the state's hash, which lives 10 minutes and is claimed once.
- **Disconnect:** the mailbox turns `disconnected` with its reason: `user` (the member), `member_removed` (gamma-p6-075) or `token_revoked` (the provider answered that the grant is gone). The row stays; the tokens go.
- **Reconnect:** the connect again, by the mailbox's owner; the same address reuses its row and keeps its id.
