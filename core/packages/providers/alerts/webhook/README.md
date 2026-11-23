# webhook: the alerts adapter

**Covers.** `send` of the [alerts port](../README.md): one POST of `{"text": <text>}`, `content-type: application/json`, to the team channel's incoming webhook. It posts through Node's `fetch`, which `no-raw-fetch` allows in an adapter's folder, since `fetchSafe` is GET only ([security §5](../../../../../docs/rules/security.md#5-requests-uploads-and-egress)); no SDK, so no entry in `tools/lint/vendor-sdks.json`. A redirect is never followed (`redirect: "manual"`), the post gives up after `ALERTS_TIMEOUT_MS` (10 s), and the answer's body is read into one buffer of `ALERTS_ANSWER_MAX_BYTES` (16 KiB), never past it, then dropped: the status decides. A 2xx is `{}`; a 429 is `alerts_rate_limited`, with `retryAfterSec` when `Retry-After` is in seconds (a date is not read); another 3xx or 4xx is `alerts_rejected`; a 5xx, a network error or the timeout is `alerts_unreachable`, with `details.reason`, `timeout` or `network` and the network error's short code (`ECONNREFUSED`). Nothing retries here: the caller decides.

**Vendor and terms.** None: the channel is the operator's own, in its own Slack, Teams or Discord workspace and under that workspace's terms. There is no vendor contract and no key of ours. Only the alert's text goes, which its caller writes without a lead's or a member's data (gamma-p7-040).

**Variables** (`deploy/.env.example`, read when the adapter starts; a refused URL fails there with `config_invalid`, naming the variable and the rule, never the URL):

| Variable | |
|---|---|
| `PROVIDER_ALERTS` | `webhook` selects this adapter; empty, no team channel ([../README.md](../README.md)) |
| `ALERTS_WEBHOOK_URL` (secret; `requires` names it) | the channel's incoming webhook URL. Its path is the channel's token: in `deploy/.env` or `.env.local` only, never in a commit, a ticket or a log line |

`create()` runs the platform's egress rules on the URL once ([platform README](../../../platform/README.md#egress-what-is-refused)): `https:`, or `http:` to a host on `EGRESS_ALLOW_HOSTS` only (a test's local server); no user name or password; no host on `EGRESS_DENY_HOSTS`, no loopback, private or other blocked literal, no port but the scheme's own unless the host is allow-listed. The host's addresses are not resolved and checked, as `fetchSafe` would: the URL is the operator's, from the server's `.env`, never a user's. There is no sandbox key: the tests run on a local server ("Tests"), and the contract suite skips while `ALERTS_WEBHOOK_URL` is empty.

**Provider refs.** None: the adapter stores nothing.

**Known differences.** The body is Slack's, `{"text": …}`. Discord takes it at the webhook URL with `/slack` appended. A Teams channel needs an incoming webhook that accepts a `text` body. What the channel renders as formatting (`*`, `_`, a link) is its own: the port sends plain text.

**Tests.** No test reaches Slack, Teams or Discord. `tests/contract.test.ts` runs the port's suite on the adapter against a channel on 127.0.0.1 (`tests/channel.ts`), reached through `EGRESS_ALLOW_HOSTS`, then each answer it plays: one POST, a 302 never followed, a 400 and a 404, a 429 with and without seconds, a 500, a refused connection, the timeout, a body held open past 16 KiB, and, in a child run, the suite skipped while the variable is empty. `tests/url.test.ts` holds the refused URLs, and a marker planted in the URL's path and in every answer's body: a child host (`tests/marker-host.ts`) posts and starts the adapter with its telemetry on, and the marker is in none of its output, nor in any span, log record or metric it exported to a local OTLP receiver.
