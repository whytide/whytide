# smtp: the app-mail adapter

**Covers.** `send` of the [app-mail port](../README.md), to one address, the text with its html alternative when given, through nodemailer's SMTP transport, one connection per mail. A stalled relay fails `send` with `mail_unreachable` after 10 s to connect, 10 s to greet or 30 s of silence (nodemailer's defaults are 2, 0.5 and 10 minutes), and nodemailer reads no file and fetches no URL into a mail (`disableFileAccess`, `disableUrlAccess`). nodemailer is imported in this folder only (`tools/lint/vendor-sdks.json`).

**Vendor and terms.** In development there is no vendor: the shared stack's Mailpit catches every mail ([deploy/README.md](../../../../../deploy/README.md)). In production the relay is the operator's, under the operator's own terms for processing and retention. The library is nodemailer 10.1.7 (MIT-0, its exception in `tools/ci/license-exceptions.json`). Its address parser had three advisories of 2026-10-19 before 10.1.4, and the bump past 10.1.4 is done. The rule stays as a defense in depth: every address goes to nodemailer as an object, `{ name: "", address }`, in the headers and in the SMTP envelope, which skips that parser; the port and the configuration check both addresses first ([../README.md](../README.md) "Addresses").

**Variables** (`deploy/.env.example`, read when the adapter starts; a missing or malformed one fails there with `config_invalid`, naming the variable, never the value):

| Variable | |
|---|---|
| `SMTP_HOST`, `SMTP_PORT` | the relay; in development Mailpit's SMTP on `127.0.0.1` at the port the stack published, filled by `pnpm env:create`; TLS below |
| `SMTP_USER`, `SMTP_PASSWORD` (secret) | both or neither, empty in development (Mailpit takes none). With them TLS is required, so the password never crosses in clear: a server without STARTTLS fails with `mail_unreachable` |
| `MAIL_FROM` | the sender of every mail, one plain address; `no-reply@whytide.localhost` in development |

**TLS.** Port 465 is TLS from the start. On another port nodemailer upgrades when the server offers STARTTLS, and a user makes the upgrade required. Without a user nothing requires it: a relay that offers no STARTTLS, or a network that strips the offer, gets the whole mail in clear, the sign-in link included. So off this host, set a user or use port 465. A relay that authenticates by IP address (Google Workspace's smtp-relay, Microsoft 365 connectors) takes no user and must still get TLS: use its port 465 where it has one.

**Resend.** To reach real inboxes, point the adapter at Resend's SMTP relay ([resend.com/docs/send-with-smtp](https://resend.com/docs/send-with-smtp)): `SMTP_HOST=smtp.resend.com`, `SMTP_PORT=465` (TLS from the start), `SMTP_USER=resend`, `SMTP_PASSWORD` the Resend API key (a secret: in `.env.local` or `deploy/.env`, never in a commit), and `MAIL_FROM` an address on a domain verified in Resend. Without a verified domain, Resend sends only from `onboarding@resend.dev`, and only to the Resend account's own address: every other recipient is refused.

`requires` names `SMTP_HOST`, `SMTP_PORT` and `MAIL_FROM`, so that deploy:check refuses a server without one (gamma-en-105); the login stays out, a pair or neither. The contract suite passes the adapter with no `requires`: it runs against the shared stack and fails, never skips, when the stack or `.env.local` is missing. No sandbox key exists or is needed.

**Provider refs.** None: the adapter stores nothing.

**Known differences.** `messageId` is the Message-ID nodemailer writes, `<uuid@` the domain of `MAIL_FROM` `>`, without the brackets. Codes: no connection, no name or no TLS (`ECONNECTION`, `ESOCKET`, `ETIMEDOUT`, `EDNS`, `ETLS`, `EPROXY`) and a 4xx reply are `mail_unreachable`; a 5xx reply is `mail_rejected`, except a refused login (`EAUTH`, 535): that is the operator's configuration, not the mail, and goes out with anything else as `mail_error_unmapped` with nodemailer's code. A relay that wants a login and gets none answers MAIL FROM with 530 "Authentication required", which still reads as `mail_rejected`.
