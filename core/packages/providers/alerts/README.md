# The alerts port

One short text to the team channel: what the worker tells the instance's own people when something needs them, never a lead or a member ([coding §6](../../../../docs/rules/coding.md#6-ports-and-adapters), [§8](../../../../docs/rules/coding.md#8-configuration)). Gamma has one team channel per instance, its incoming webhook in the server's `.env`, so no member reads or changes it. `PROVIDER_ALERTS` is empty by default: an empty selector binds nothing, and the caller (gamma-p7-040) sends nothing.

```ts
import { alertsConfig, alertsPort, getAdapter } from "@whytide/providers";

// At start: empty, no team channel, and nothing to send through.
const selector = alertsConfig.PROVIDER_ALERTS;
const alerts = selector ? await getAdapter(alertsPort, selector) : undefined;
await alerts?.send({ text: "activity linkedin.sendInvite: linkedin_rate_limited ×3" });
```

## The method and the codes

`send({ text })` returns `{}`. `text` is 1 to `ALERT_TEXT_MAX` (2,000) characters, counted as JavaScript counts them, in UTF-16 code units: Discord's limit. Newlines are kept; any other control character (a tab, a carriage return, an escape) is refused. The port is `alerts` (`PROVIDER_ALERTS`), its codes take the prefix `alerts`:

| Code | When |
|---|---|
| `alerts_rejected` (502) | the channel refused the text for good: any 3xx (never followed), or a 4xx other than 429, such as a removed webhook or a malformed body |
| `alerts_rate_limited` (429) | the channel asks to wait: `details.retryAfterSec` holds the seconds of its `Retry-After`, when it gave seconds |
| `alerts_unreachable` (503) | nothing answered: a 5xx, a network error or the adapter's timeout; try again later |
| `alerts_input_invalid` (400), `alerts_output_invalid`, `alerts_error_unmapped` (500) | the pattern's own ([../README.md](../README.md) "The boundary") |

`details` hold the answer's status, the seconds asked for, or why nothing answered (`reason`, `timeout` or `network`, with the network error's short code), never the URL or what the channel answered: the webhook URL is a secret, and its path is the channel's token. The port will never have a channel, a mention, a user, blocks or attachments per text: one plain text goes to the instance's one channel. No message keys: the codes are provider codes, as app mail's are.

## Adapters

| `PROVIDER_ALERTS` | |
|---|---|
| empty | the default in both `.env` examples: no team channel, the port is not bound |
| `webhook` | one POST to the channel's incoming webhook: Slack's, Discord's, or a Teams workflow's ([webhook/README.md](webhook/README.md)) |
| `fake` | in memory, for module tests: `alertsFake.sent()` lists every text since the last reset; `failNext` as for every fake |

## The contract suite

`contract.ts` holds `alertsCases(channel)`: a text sent as given, its newlines and any script kept; a text of `ALERT_TEXT_MAX` characters whole; an empty text, a longer one, a control character and a key the port lacks, each `alerts_input_invalid` before any call; and each code from the channel's answer, the rate limit with its seconds. An `AlertsChannel` reads back what arrived (`received`), counts the calls, and fails the next one with a code (`failNext`). `fake/tests/contract.test.ts` runs the suite on the fake; `webhook/tests/contract.test.ts` on the adapter, against a local server on 127.0.0.1 playing each answer; `tests/contract.test.ts` on the fake through the registry, with the port's own tests: an empty `PROVIDER_ALERTS` binds nothing, and the codes with their statuses. A new method comes with its cases here; `pnpm -F providers test:contract` runs them all.
