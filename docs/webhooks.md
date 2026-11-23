# Webhooks

Every webhook Whytide receives or sends, and where each one is set up. The details live with the code; this page lists them and links there.

## Received

A module that exports `webhooks` from its `index.ts` gets one route on the api: `POST /v1/<module>/webhooks/<provider>` ([core/apps/api/src/webhooks.ts](../core/apps/api/src/webhooks.ts)). The route:
- runs outside any workspace, with no session;
- is rate-limited per client address (`RATE_LIMIT_WEBHOOK_PER_IP_PER_MIN`, 120 by default);
- reads the body raw, up to the module's limit: 413 above it, 415 for a compressed body;
- hands the call to the module, which checks the vendor's proof before it parses the body;
- answers 204 once the module has taken the call, an event it ignores included.

Today one module receives webhooks: linkedin, from Unipile.

### LinkedIn, from Unipile

Unipile calls `UNIPILE_NOTIFY_URL`, the public address of `POST /v1/linkedin/webhooks/unipile`. That address depends on where Whytide runs:

| Where Whytide runs | `UNIPILE_NOTIFY_URL` |
|---|---|
| A server, from `deploy/` | `https://<domain>/v1/linkedin/webhooks/unipile`: Caddy sends `/v1/*/webhooks/*` to the api ([deploy/Caddyfile](../deploy/Caddyfile)) |
| A laptop, with a tunnel to the web's port | `https://<tunnel host>/api/v1/linkedin/webhooks/unipile`: the web passes `/api/v1/*` on to the api ([core/apps/web/next.config.ts](../core/apps/web/next.config.ts)). Without `/api`, the web answers its own 404 page and every call is lost |
| A laptop, with a tunnel to the api's port | `https://<tunnel host>/v1/linkedin/webhooks/unipile` |

Three webhooks are registered in Unipile with `pnpm unipile:webhooks register` (below), once per Unipile API account, not per LinkedIn account. Each has that URL, the format `json` and the header `Unipile-Auth` set to `UNIPILE_WEBHOOK_SECRET`:

| Source | Events | What Whytide does |
|---|---|---|
| `messaging` | `message_received` | stores the message in the inbox thread and holds the person's campaign steps |
| `users` | `new_relation` | marks the connection request accepted; the campaign's first message falls due 1 to 3 hours later and goes out after its approval, in the account's weekday working hours |
| `account_status` | `ok`, `reconnected`, `creation_success`, `sync_success`, `credentials`, `error`, `stopped`, `deleted`, `connecting`, `creation_fail`, `permissions` | the account reads `connected` on the first four and `credentials_required` on `credentials`; any other sets it `disconnected` until one of the first four comes |

One more call is not registered: when an account connects through Whytide's connect link, Unipile posts to the link's `notify_url`, which is `UNIPILE_NOTIFY_URL`. That call has no header; the pairing token in the link's name proves it.

**Registering and checking.** `pnpm unipile:webhooks <command> [--env-file <path>]`, from the repository root ([deploy/scripts/unipile-webhooks.ts](../deploy/scripts/unipile-webhooks.ts)), reads the `UNIPILE_` variables from `--env-file`, else `.env.local` at the root (a laptop), else `deploy/.env` (a server). It reads the file as text and prints its path, never a value; the key, the secrets, the webhooks' headers and Unipile's answers never show:
- `check`: each variable, fine or wrong, then one listing that proves the key, with the `whytide-*` webhooks and their URLs;
- `register`: removes the webhooks named `whytide-messaging`, `whytide-users` and `whytide-account_status`, never one of another name, creates the three, then lists them; safe to run again;
- `list`: every webhook's id, name and URL, never its headers, which hold the secret;
- `remove`: removes those three and no other.

On a server, and without Node there: [deploy/docs/runbook.md](../deploy/docs/runbook.md) "LinkedIn webhooks". The API's calls themselves are in the Unipile adapter's README ([core/packages/providers/linkedin/unipile/README.md](../core/packages/providers/linkedin/unipile/README.md) "Webhooks").

**Register again** when the address or the secret changes:
- a new address (a free tunnel gets one each time it starts): set `UNIPILE_NOTIFY_URL` to it and restart the api, which reads it once at start. Then run `pnpm unipile:webhooks register`, which removes the three old webhooks and creates them at the new address;
- a new `UNIPILE_WEBHOOK_SECRET`: in the order the adapter's README gives under "Variables", registering with `pnpm unipile:webhooks register`.

**The answers.**
- 204: taken.
- 401 `linkedin_webhook_invalid`, which changes nothing. Its `reason` is `secret` for a wrong `Unipile-Auth` header, `token` for a call with no header and no valid pairing token, `body` for a verified body that is not the documented shape, or `provider` for a path provider other than `PROVIDER_LINKEDIN`'s.
- 409 `sender_account_in_use`: a connect's notify for a LinkedIn account another user already connected in the same workspace. Unipile's retry then gets 204.
- 413, 415 and 429: as for any module's webhook, above.

**A missed call.** Unipile retries a call five times, then gives up, and it sends no message webhooks while an account is not OK.
- An acceptance is found anyway, within about a day: once a day per account, at a random time, the hourly status check reads the pending connection requests and records an acceptance the webhook missed.
- A reply is not: the inbox shows a reply only when its `message_received` arrived. Before each message it sends, campaigns' sender reads the chat, so a sequence never goes on past a reply it missed.

## Sent

**Alerts to a team channel.** The alerts port's `webhook` adapter posts `{"text": "…"}` to a team channel's incoming webhook ([core/packages/providers/alerts/webhook/README.md](../core/packages/providers/alerts/webhook/README.md)).
- Set `PROVIDER_ALERTS=webhook` and `ALERTS_WEBHOOK_URL`, the channel's incoming webhook URL. That URL is a secret: its path is the channel's token.
- Slack takes the body as it is. Discord takes it at the webhook URL with `/slack` appended. A Teams channel needs an incoming webhook that accepts a `text` body.
- Only the alert's text goes, never a lead's or a member's data.
- No module sends an alert yet: gamma-p7-040 adds the error alerts.

Whytide calls no other webhook.
