# The app-mail port

The mail the app sends itself: the sign-in link first, then invites and alerts ([coding §6](../../../../docs/rules/coding.md#6-ports-and-adapters), [§8](../../../../docs/rules/coding.md#8-configuration)). In development every mail lands in the shared stack's Mailpit through `smtp`, where tests and people read it; no real mail leaves a development environment. Outreach mail is not this port (gamma).

```ts
import { appMailConfig, appMailPort, getAdapter } from "@whytide/providers";

const mail = await getAdapter(appMailPort, appMailConfig.PROVIDER_APP_MAIL); // at start
const { subject, body } = renderMail(key, params, locale); // @whytide/platform
await mail.send({ to, subject, text: body });
```

## The method and the codes

`send({ to, subject, text, html? })` returns `{ messageId }`, the mail's Message-ID without its angle brackets. `to` is one plain address (below), `subject` one line, `text` the plain body, always there; `html` an alternative to it. The port is `app_mail` (`PROVIDER_APP_MAIL`), its codes take the prefix `mail` (`errorPrefix`):

| Code | When |
|---|---|
| `mail_rejected` (502) | the server refused the mail for good, a 5xx reply: the address, the sender or the content |
| `mail_unreachable` (503) | nothing reached the server (no connection, no name, no TLS), or it answered 4xx: try again later |
| `mail_input_invalid` (400), `mail_output_invalid`, `mail_error_unmapped` (500) | the pattern's own ([../README.md](../README.md) "The boundary") |

`details` hold the adapter's short code and the SMTP reply code, never the server's message, which quotes the address. The port will never have cc, bcc, a list of recipients, attachments, headers or a sender per mail: one mail goes from the app to one person.

## Addresses

`to`, and `MAIL_FROM` of `smtp`, are one plain address (`plainAddress`): letters, digits, `_`, `'`, `+`, `-` and dots before the `@`, a domain of letters, digits and hyphens ending in a name of letters or a punycode one (`xn--`), at most 254 characters. No display name, comment, group, list, quotes, angle brackets or line break, so no address parser has anything to misread: nodemailer before 10.1.4 sends to an address the header does not name when one hides a quoted `>` or `;` or a nested comment (GHSA-85x2-q946-cp5h, GHSA-m943-m63m-w62w, GHSA-8c8m-p3m8-cjg8). A domain outside ASCII goes in punycode; a local part outside ASCII is refused.

## Adapters

| `PROVIDER_APP_MAIL` | |
|---|---|
| `smtp` | the default in `deploy/.env.example`: nodemailer to `SMTP_HOST`, Mailpit in development ([smtp/README.md](smtp/README.md)) |
| `fake` | in memory, for module tests: `appMailFake.sent()` lists every mail since the last reset, `appMailFake.read({ to })` returns the latest to an address; `failNext` as for every fake |

## Reading the mail

`readMailpit({ to }, { timeoutMs })` in `testing/` waits up to 5 s for the latest mail to `to` in Mailpit and returns `{ messageId, recipients, subject, text, html? }`, as `appMailFake.read` does: `recipients` lists every address the mail went to (To, Cc, then Bcc, where Mailpit puts an envelope recipient no header names), and the text has `\n` line breaks and no trailing one. It finds Mailpit's API through `MAILPIT_API_URL`, which `pnpm env:create` fills from the port the stack published; `loadEnvLocal()` reads the worktree's `.env.local` first, never over the environment. Mailpit is one inbox for every worktree on the laptop: send to a fresh address (a random local part at `example.test`), read that one only, delete nothing. Its `fetch` passes `no-raw-fetch` because the lint allows the global `fetch` in test code, which includes a port's `testing/`; it calls the stack's Mailpit and nothing else.

## The contract suite

`contract.ts` holds `appMailCases(read)`: a Unicode text mail and an html one, each read back from the adapter's mailbox under the `messageId` `send` returned with its one address as the only recipient, and the refusals of the address rule, of a two-line subject and of a `cc` key. `fake/tests/contract.test.ts` passes `appMailFake.read`, `smtp/tests/contract.test.ts` passes `readMailpit` and runs against the shared stack: Mailpit is local, so the suite never skips. `tests/contract.test.ts` proves that the address rule takes the plain shapes, a punycode domain and top-level domain included, and that a module file importing `nodemailer` fails the lint. A new method comes with its cases here; `pnpm -F providers test:contract` runs them all.
