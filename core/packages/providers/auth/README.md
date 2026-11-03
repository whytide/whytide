# The authentication port

The API depends on this port and on nothing of the library behind it (docs/architecture.md §9 "Authentication"; docs/15 §5 in the planning repository): it resolves the principal of a request, signs a user out everywhere, revokes a user, sends a sign-in link and reports a second factor. Everything else in the product works with the principal. The fake runs the api's tests and the Compose smoke test; the Better Auth adapter ([better-auth/README.md](better-auth/README.md)) runs the app. The port follows the package's pattern ([README.md](../README.md)).

## Methods

| Method | Input → output | Does |
|---|---|---|
| `configure` | `{ allowSignIn, mail, users }` → nothing | takes the hooks below; the api calls it once at start |
| `mountHandler` | `app` → nothing | mounts the adapter's routes under `/api/auth/` ("Mounting the handler") |
| `resolvePrincipal` | `request` → `{ userId, sessionId }` or `null` | the session in the request's cookie; `null` for no cookie, an unknown, ended or expired session |
| `requestMagicLink` | `{ email, redirectTo }` → nothing | `allowSignIn` first, then a link mailed through the `mail` hook |
| `signOutEverywhere` | `userId` → nothing | ends every session of the user; links already mailed still work for their 15 minutes; `revokeUser` stops them |
| `revokeUser` | `userId` → nothing | ends every session of the user, and no link signs the user in again; the Better Auth adapter also disables the user in the users store (alpha-p3-020) |
| `isSecondFactorEnrolled` | `userId` → `boolean` | `false` in alpha |

`sessionId` is an id, never the token: it may go in a log line. The port trims and lowercases the email and caps it at 254 characters before an adapter sees it: every hook gets `ada@example.com`. The hooks, the app and the request are opaque values, checked by shape with `z.custom` (the opt-out of the package README's "The boundary").

| Code | Status | When |
|---|---|---|
| `auth_invite_required` | 403 | `allowSignIn` refused the email: no link, no mail, no user |
| `auth_link_expired` | 410 | a link unknown, used already, older than its lifetime, or refused since it was mailed: the handler redirects to `AUTH_LINK_FAILED_PATH` with it |
| `auth_session_invalid` | 401 | the api's guard, when `resolvePrincipal` returns `null` (alpha-p2-010) |
| `auth_hook_invalid` | 500 | the users hook returned no `id`: a host bug, given to `next(error)` |
| `auth_fake_in_production` | 500 | the fake's `create()` under `APP_ENV=production` ("The fake") |

No error carries an email, a token or a cookie value; the fake logs nothing. The codes are developer-facing: the screens of alpha-p3-040 decide what a person sees.

## The hooks

`configure({ allowSignIn, mail, users })` is how the identity module plugs in without an adapter importing a module. `allowSignIn(email)` is the invite-only rule (alpha-p3-030): anything but `true` refuses. `mail` is the app-mail port (alpha-p1-110), or anything with its `send({ to, subject, text, html? })`. `users.findOrCreateByEmail(email)` returns the user, `{ id }` with a non-empty string `id`, created when the link is followed, never when it is requested; `users.findByEmail` and `users.disable` are optional, for the Better Auth adapter (its README). The input is strict: a hook the port does not know fails with `auth_input_invalid`.

## Mounting the handler

The handler is connect-style, `(req, res, next)` on node:http's request and response, and `mountHandler(app)` calls `app.use(handler)` once: a NestJS app (`app.use`, on Express or, through `@fastify/middie`, on Fastify), an Express app, or a plain node:http server through three lines:

```ts
const mounted: AuthHandler[] = [];
await auth.mountHandler({ use: (handler) => mounted.push(handler) });
createServer((req, res) => mounted[0]?.(req, res, (e) => res.writeHead(e ? 500 : 404).end()));
```

The handler answers its own routes under `/api/auth/` and calls `next()` for any other request and for one whose URL does not parse; it never throws, and writes nothing once the host has answered. `next(error)` only ever receives one of the port's codes: `auth_hook_invalid`, or `auth_error_unmapped` around whatever a hook threw, its `cause` kept outside production only, as `bindPort` wraps an error; and, from the fake's test sign-in route, `auth_input_invalid` and `auth_invite_required` ("Signing in from tests").

## The sign-in link

`redirectTo` is a path inside the app, `authRedirectPath` in `port.ts`, with which alpha-p3-020 also checks Better Auth's `callbackURL`: printable ASCII after one `/`, which a browser resolves to the app's own origin and to no `//` path, with no `%2F` or `%5C`, and nothing under `/api/` once percent-decoded, in any case. A scheme, `//host`, `/\host`, `/.//host`, a control character or an `/api/` path fails with `auth_input_invalid`: the redirect after sign-in neither leaves the app nor lands on another sign-in link (login CSRF). A link works once and lives 15 minutes (`AUTH_LINK_TTL_MS`); `allowSignIn` and `revokeUser` still hold when it is followed. Following it answers 303 to `redirectTo` with the session cookie. A failed link, unknown, used, expired or refused, answers the same bytes every time: 303 to `/sign-in/expired?code=auth_link_expired` (`AUTH_LINK_FAILED_PATH`), with no cookie. Both answers carry `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

**The confirm step** (`confirm.ts`, both adapters): a mail scanner opens the mailed link with a GET, so the GET signs no one in and spends nothing: it answers 303 to `AUTH_LINK_CONFIRM_PATH`, `/sign-in/confirm?link=<the link's path and query>`, identity's page with a Sign in button. The button POSTs to the link, and only that POST follows it, when it comes from the app's own pages: `Sec-Fetch-Site: same-origin`, or, without that header, an `Origin` on the request's own `Host`, when it has one, or the Better Auth adapter's `AUTH_BASE_URL` (`Origin: null` never passes). A POST from elsewhere answers the failed link's 303 and spends nothing: a cross-site form cannot sign a visitor in as someone else.

## The session cookie

Every adapter sets the same cookie, `authSessionCookie` in `port.ts`; Better Auth is configured with these values:

| Attribute | Value | Why |
|---|---|---|
| name | `__Host-whytide_session` when `Secure`, `whytide_session` otherwise | the prefix keeps a sibling subdomain from planting the cookie; set now, since a rename signs everyone out |
| `HttpOnly` | always | no script reads the session |
| `SameSite` | `Lax` | sent on the top-level navigation from a mail client, so the link works; alpha-p2-030's origin check covers the rest |
| `Path` | `/` | the web and the api share the origin |
| `Max-Age` | 30 days (`AUTH_SESSION_TTL_MS`) | the session's absolute lifetime, checked by the adapter too |
| `Secure` | when `APP_ENV=production` | the development and test servers speak plain HTTP, so `Secure` and the `__Host-` name need `APP_ENV=production`; an unset `APP_ENV` stops the host at start |
| `Domain` | none | host-only: no sibling subdomain receives it |

## Rules for the routes that come next

- A route that requests a link, alpha-p3-040's and Better Auth's own once mounted, answers a refused and an invited email the same way, in status, body and time: it sends the mail after responding. It is rate-limited per email and per client.
- The token travels in the query string: the platform must add `token` to the HTTP instrumentation's `redactedQueryParams` (`redactedQueryParamsServer` for the requests it receives), and the edge's access log must drop it.

## The fake

`fake/` keeps the links and the sessions in memory under the SHA-256 of their tokens (32 random bytes from `node:crypto`): its stores hold digests only. `authFake.links()` holds the mailed links, tokens included, `{ email, url }`, newest last, for a test that reads the link instead of Mailpit. Its route is `/api/auth/fake/verify?token=…`, a GET and the confirm page's POST, with a second under `APP_ENV=test` ("Signing in from tests"), and its links are paths on the host that mounts the handler: a test resolves one against its own server. Until `configure` runs the fake refuses every email; `reset()` clears links, sessions and revocations and keeps the configuration. Its `revokeUser` ends the sessions and refuses the user's links until `reset()`: disabling the user belongs to the users store. `recordedCalls` keeps no `resolvePrincipal` call: the api makes one on every request, and no request or cookie stays in memory. `create()` refuses `APP_ENV=production` with `auth_fake_in_production`; a host awaits `getAdapter` at start, so the refusal stops the start.

## The contract suite

`contract.ts` holds the cases every adapter passes, through the mounted handler on a node:http server and real requests: until `configure` runs every email is refused; a link for an allowed email signs the user in and `resolvePrincipal` finds the user by the cookie, with the attributes above, whatever parameters are added to the link; a consumed and an expired link fail; a link's GET opens no session and spends nothing, and a POST from another site fails; a session ends after its lifetime; `signOutEverywhere` and `revokeUser` end every session of the user and no one else's; a link requested before `revokeUser`, or whose email is refused by the time it is followed, opens no session; a users hook that fails or returns no `id` gives `next` a port code; a request whose URL does not parse goes on to the host; a refused email fails with `auth_invite_required` and mails nothing; a `redirectTo` outside the app or under `/api/`, or an email over 254 characters, fails with `auth_input_invalid`. `authCases(follow)` takes the function that requests a link, a GET or the confirm page's POST, `fetch` with `redirect: "manual"` in the adapter's own `tests/contract.test.ts`, where `no-raw-fetch` allows it; the one request `fetch` cannot send goes over a `node:net` socket, and every request reaches `127.0.0.1` only.

## Selecting the adapter

`PROVIDER_AUTH` in `config.ts`, `better-auth` in `deploy/.env.example`, `fake` in the api's tests; the api resolves it with `await getAdapter(authPort, authConfig.PROVIDER_AUTH)`, all three from `@whytide/providers`. `better-auth` is imported only in `better-auth/` (`tools/lint/vendor-sdks.json`).

## Swapping the library

A new adapter folder `auth/<library>/` passing the contract suite, with its entry in `tools/lint/vendor-sdks.json`; new sign-in screens; one migration for its sessions and verifications, after which everyone signs in again. Nothing in the modules, the worker or the rest of the API changes. A new method is a schema pair in `port.ts`, a case in `contract.ts`, and every adapter.

Never across the port: a library's object, a password or a token in our words. Passwords, Google and Microsoft sign-in, second factors, passkeys and OAuth for MCP come in later versions, through this port.

## Signing in from tests

Tests sign in through helpers, not screens (docs/rules/delivery.md §4), on the fake only: no real adapter has either of these.

`signInAs(userId, { domain })`, in `testing/index.ts`, opens a session of the user on the fake of the process it runs in, through `authFake.createSession(userId)`, asking no hook, and returns its cookie as Playwright's `context.addCookies` takes it: `[{ name, value, domain, path, httpOnly, secure, sameSite: "Lax" }]`, host-only on `domain` (`localhost` unless given), the other fields those of the session cookie. An API test sends `name=value` as its `Cookie` header and `resolvePrincipal` finds the user, provided its api runs in the same process on the fake. A revoked user gets `auth_invite_required`, as on every way in, an empty id `auth_input_invalid`, and under production, on a fake mounted by hand too, `createSession` refuses with `auth_fake_in_production`, as `create()` does; `reset()` ends the session.

An app in another process does not see that session. A test signs in there with `POST /api/auth/fake/sign-in` and `{ "email": … }`, which the fake's handler serves under `APP_ENV=test` only: not under development, and never in production, where the fake refuses to start; without `APP_ENV` no host starts at all. `APP_ENV=test` is for test processes on a laptop or in the pipeline, never on a server other people can reach: there one POST signs anyone in as any invited email, so a shared or staging server runs `development`. The route reads its own body, so the host mounts the handler before its body parsers: `application/json`, so that no cross-site form can post it, 4,096 bytes at most, exactly `{ email }`, the email trimmed and lowercased as the port does. It asks `allowSignIn` and the users hook as following a link does and answers 204 with the session cookie, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. A refused or revoked email gets `auth_invite_required`, any other body `auth_input_invalid`, through `next(error)` and with no cookie. A body over the limit, declared or sent, is refused at once and the rest never read: the answer closes the connection or, when the host has answered already, the request ends there; a body cut short, the client gone, gets `auth_input_invalid` too. Unlike a route that requests a link, it tells a refused email from an invited one: it exists in tests only.

`tests/contract.test.ts` boots the handler under `test`, `development`, an unset `APP_ENV` (which stops at the platform's import) and `production`, and proves the helper and the route through real requests.
