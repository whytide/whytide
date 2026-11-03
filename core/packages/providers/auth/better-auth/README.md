# better-auth: the authentication adapter

**Covers.** Every method of the [authentication port](../README.md), with Better Auth 1.7.8 (MIT) and its magic-link plugin; it passes the port's contract suite. `requestMagicLink` asks `allowSignIn` and the users hook's `findByEmail` (a disabled or revoked user gets `auth_invite_required`), stores the link under the SHA-256 of its token (`storeToken: "hashed"`) for 15 minutes, and mails it through the `mail` hook, subject and body from `renderMail("identity.mail.sign_in", { url }, defaultLocale())`. The handler serves one route, `/api/auth/magic-link/verify?token=…&callbackURL=…`, a GET that lands on the confirm page and the page's POST that follows the link (../README.md "The sign-in link"), its raw path exactly as the host's rate limit reads it (no dot segment, backslash or other spelling), and calls `next()` for anything else: Better Auth's router is never mounted, so it reads no request body and its own link request (`POST /api/auth/sign-in/magic-link`) does not exist. Following a link asks `allowSignIn` and `users.findOrCreateByEmail` again and answers the port's 303s. `revokeUser` refuses the user's links from then on, ends the sessions and calls `users.disable(userId)`. `isSecondFactorEnrolled` is `false`. Better Auth is imported in this folder only (`tools/lint/vendor-sdks.json`).

**Vendor and terms.** None: a library inside the api process that sends nothing anywhere. Its telemetry, logger and rate limiter are off (the api host limits every `/api/auth/*` request per address, alpha-p2-030). The adapter refuses to start while any `BETTER_AUTH_*` variable is set (`config_invalid`, naming the variable, never its value): `BETTER_AUTH_SECRET(S)`, `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS` and `BETTER_AUTH_TELEMETRY*` would win over its settings or add to them.

**Variables** (`deploy/.env.example`, read when the adapter starts; `requires` names none, the tests run on the worktree's database and Mailpit):

| Variable | |
|---|---|
| `PROVIDER_AUTH` | `better-auth`, the default; the api's tests pin `fake` |
| `AUTH_SECRET` (secret) | signs the session cookie, 32 characters or more. Empty outside production: a random key per process, so a restart signs everyone out. Required under `APP_ENV=production` |
| `AUTH_BASE_URL` | the origin the browser opens links on, the web's once it proxies `/api/auth/*`; empty: `http://127.0.0.1:API_PORT`. Required under `APP_ENV=production` |

**Provider refs.** None; the adapter's own tables instead, in `core/packages/db/prisma/schema/auth.prisma` (migration `auth_better_auth_tables`), read and written by the `app` role:

| Table | Holds |
|---|---|
| `sessions` | `ses_` id, `token_hash` (the SHA-256 of the cookie's token, never the token), `user_id`, `expires_at`, `ip`, `user_agent` (512 characters at most) |
| `verifications` | `ver_` id, the link's hashed token in `identifier`, its email in `value`, `expires_at`; deleted when followed |
| `accounts` | `acc_` id, `account_id`, `provider_id`, `user_id`: unused by the link, kept for later sign-in methods |

No users table: Better Auth's user model goes to the users hook (`store.ts`), so users stay tenancy's and no column is added to `users`. Better Auth finds no user by email, so following a link always asks `users.findOrCreateByEmail`; it reads a session's user back as its id, with `emailVerified: true` and an empty `name`. `user_id` has no foreign key: these tables go with the adapter.

**The hooks.** As the port's README says, plus two optional methods of `users`: `findByEmail(email)`, `{ id, disabledAt }` or `null`, so that a disabled user gets no link; and `disable(userId)`, which sets `users.disabled_at` for `revokeUser`. Without `disable` a revocation holds in this process only. A user from `findOrCreateByEmail` with a `disabledAt` is refused too.

**The cookie.** The port's `authSessionCookie`, signed by Better Auth with `AUTH_SECRET`. A session is never extended on use (`disableSessionRefresh`): it ends 30 days after the link was followed.

**Tests.** `tests/contract.test.ts`, `tests/mail.test.ts` (Mailpit and the tables) and `tests/config.test.ts`. A test hands the adapter its schema's client before it starts, `useAuthDatabase(asRole("app"))` from `@whytide/providers/auth/testing`; otherwise the adapter makes the `app` role's client of `@whytide/db`. `core/apps/api/tests/better-auth.test.ts` follows a link to `GET /v1/me`.

**Known differences.** A link whose `callbackURL` fails `authRedirectPath` fails without being spent. Swapping the library: the port README's "Swapping the library"; this folder, its vendor-SDK entry and `auth.prisma` go together.
