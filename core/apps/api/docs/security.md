# Request protection

The four protections of [security §5](../../../../docs/rules/security.md#5-requests-uploads-and-egress) that the host applies to every request: rate limits, origin checks, headers, idempotency keys, plus the body limits. `src/protection/` holds them and `src/app.ts` mounts them, at steps 2, 7, 9 and 11 of [the request path](request-path.md). Their codes are developer-facing, without message keys.

## Rate limits

- Per workspace on `/v1/workspaces/:workspaceId/…`: `RATE_LIMIT_WORKSPACE_PER_MIN` requests a minute (600). The guard runs after the workspace guard, so only a member's requests count.
- Per client address on `/api/auth/…` and `POST /v1/sign-in`: `RATE_LIMIT_AUTH_PER_IP_PER_MIN` (20), ahead of the authentication handler. The address is Express's `req.ip` with `trust proxy` set to `TRUST_PROXY`: loopback, link-local and private addresses by default, Caddy's address alone in production (deploy/README.md), so the client's address comes from `X-Forwarded-For` behind such a proxy and is the peer's otherwise. An IPv6 client counts by its /64, which one client holds whole. Redis keeps the SHA-256, never the address.
- Per client address on a module's webhook route, `POST /v1/<module>/webhooks/<provider>`: `RATE_LIMIT_WEBHOOK_PER_IP_PER_MIN` (120), the address taken as above, before the body is read.
- Per email on `POST /v1/sign-in`: 3 a minute (`SIGN_IN_PER_EMAIL_PER_MIN`), keyed by the email's HMAC-SHA-256 under a key derived from `AUTH_SECRET` (random per process when unset, outside production), so Redis holds nothing one can recompute from an email; a refused email counts as an invited one does.
- A sliding window: one counter per key and minute in Redis, `<REDIS_PREFIX>rate:<kind>:<id>:<minute>`, kept two minutes. A request counts the current minute plus the previous one, weighted by the share of the last 60 seconds still inside it.
- Over the limit: 429 `rate_limited` with `Retry-After`, the seconds until the next request fits. A refused request is not counted.
- Redis unreachable: requests go through, one warning a minute at most is logged, and `GET /health` answers 503 with `redis: "failing"`. The client waits 500 ms per command and 2 s for the first connection at start, then reconnects by itself.
- Telemetry: the counter `api.rate_limit.decisions`, with `kind` (`workspace`, `auth`, `webhook`, `email`) and `outcome` (`allowed`, `limited`, `unavailable`).

## Origin checks

- A request with any method but GET, HEAD and OPTIONS that carries the session cookie needs `Sec-Fetch-Site: same-origin` or an `Origin` equal to `APP_PUBLIC_ORIGIN`, or, under `APP_ENV=development` only, to `WEB_DEV_ORIGIN`. Otherwise it gets 403 `origin_rejected`, before the authentication handler and the routes.
- A request without the session cookie is not checked: it carries no session to abuse.
- The session cookie stays `SameSite=Lax`, so that a sign-in link opened from a mail client still works; the origin check covers the rest. No CORS headers in alpha.
- A client outside a browser that sends the cookie (a script, an `.http` file) also sends `Origin: <APP_PUBLIC_ORIGIN>`.

## Headers

| Header | Value | On |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | every answer |
| `Referrer-Policy` | `no-referrer` | every answer |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | every answer |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | every answer, `APP_ENV=production` only |
| `Cache-Control` | `no-store` | `/v1/` |
| `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'` | `/v1/` |

They are set before anything answers, so errors and the 404 carry them too. No answer has a `Server` header, and `X-Powered-By` is off.

## Idempotency keys

- `@Idempotent()` on a handler that spends credits or calls a provider. The client sends `Idempotency-Key: <a UUID>` and the same key on a retry. Without one: 400 `idempotency_key_required`. A value that is not a UUID: 400 `invalid_idempotency_key`.
- The handler runs inside `withIdempotency` (`core/packages/platform/idempotency`), in the tenant run, so the record commits with the handler's writes. The request hash is the SHA-256 of the method, the path with its query, and the body as JSON with sorted keys.
- A replay gets the stored status and body with `Idempotent-Replayed: true`, and the handler does not run. The same key with another request: 422 `idempotency_key_reused`. Two at once: one runs, the other gets 409 `idempotency_key_conflict`. An error is not stored, so a retry runs the handler again. Records last 24 hours.
- A workspace route only. A module cannot import the host, so it writes `SetMetadata("whytide:idempotent", true)`.

## Body limits

- NestJS's body parsers are off. The host reads the body after the guards, with the route's limit.
- JSON only (`application/json`, UTF-8, no `Content-Encoding`), 1 MB, or the route's `@BodyLimit(bytes)` (`SetMetadata("whytide:body-limit", bytes)`). Over the limit: 413 `payload_too_large`, at once on a `Content-Length`, otherwise as soon as the bytes read pass it. The rest is never read, and the answer closes the connection.
- `multipart/form-data` reaches only a route with `@Multipart()` (`SetMetadata("whytide:multipart", true)`). The host checks its `Content-Length` and leaves the stream to the route's parser, which keeps to the limit (alpha-p5-030).
- Another type, charset or encoding: 415. JSON that does not parse: 400 `invalid_request`. The handler gets the value as `@Body()` and the bytes as `req.rawBody`.
- A module's webhook route reads its body raw, of any type, within the module's `bodyLimit` (1 MB at most): 413 over it, the same way; 415 with a `Content-Encoding`. The module checks the vendor's signature on those bytes.

## Settings

The `apps/api` block of `deploy/.env.example`:

| Variable | Default | |
|---|---|---|
| `REDIS_URL` | `redis://127.0.0.1:6379` | secret; `pnpm env:create` fills the slice's |
| `REDIS_PREFIX` | empty | the start of every key; the slice's name in development |
| `RATE_LIMIT_WORKSPACE_PER_MIN` | 600 | |
| `RATE_LIMIT_AUTH_PER_IP_PER_MIN` | 20 | |
| `RATE_LIMIT_WEBHOOK_PER_IP_PER_MIN` | 120 | per address on a module's webhook route |
| `APP_PUBLIC_ORIGIN` | empty | the web app's origin, `https://app.example.com`; while empty, only `Sec-Fetch-Site: same-origin` passes |
| `WEB_DEV_ORIGIN` | empty | the web's development server, `http://127.0.0.1:<WEB_PORT>`; read under `APP_ENV=development` only |

## Decided here

- `@redis/client` (the Redis project's own client, MIT), not ioredis: one package with no dependencies.
- A body reader of the host's own, not body-parser: body-parser reads the rest of a body past its limit to keep the connection open.
- Rate limits fail open: a request is never refused because Redis does not answer, and `/health` reports it.
- The workspace limit counts after the workspace guard: another workspace's id costs a stranger a 403, never the workspace's quota.
- The hash covers the path as sent, with its query, rather than the route template. A replay answers the route's status, which is the stored one.
