# The request path

What the api does with a request, in order ([architecture §5](../../../../docs/architecture.md#5-a-request-end-to-end)). Each step is a hook point; the host only orders the platform's primitives. `src/app.ts` mounts them.

| # | Step | File | Answers on failure |
|---|---|---|---|
| 1 | Request context: a request id, sent back as `X-Request-Id` on every answer; the request log line at the end | `src/request-context.ts` | |
| 2 | Request protections ([security.md](security.md)): the security headers; the origin check of a cookie-carrying change; the authentication routes' rate limit, per address | `src/protection/` | 403 `origin_rejected`; 429 `rate_limited` |
| 3 | The authentication port's handler (`/api/auth/*`), which reads its own body | provider `auth` | its port codes, through the error filter |
| 4 | The routes; NestJS's body parsers are off | | 404 `not_found` (no route) |
| 5 | Principal guard: `resolvePrincipal` reads the session; skipped on the host's `@Public()` routes (health), which a module cannot mark | `src/principal.ts` | 401 `auth_session_invalid` |
| 6 | Workspace guard, on `/v1/workspaces/:workspaceId/…` only: the `workspaceResolver` (identity's: tenancy's `resolveMembership`) gives the principal's membership, on every request | `src/workspace.ts` | 403 `forbidden`; 500 `workspace_resolver_invalid` |
| 7 | The workspace's rate limit | `src/protection/rate-limit.ts` | 429 `rate_limited` |
| 8 | Permission guard: `can(principal, action, { workspaceId })` for the route's `@Permission` | `src/permission.ts` | 403 `forbidden`; 500 `permission_undeclared` |
| 9 | Body reader: JSON within the route's limit; multipart on `@Multipart()` routes only | `src/protection/body.ts` | 413 `payload_too_large`; 400 or 415 `invalid_request` |
| 10 | Tenant run: `withLogContext({ workspace_id, actor })` and `withTenant` on the host's `app` client, around steps 11 to 13; on an `@OwnRuns()` route (`whytide:own-runs`), `withLogContext` only, the tenant left on `req.tenant` for the handler's own runs | `src/workspace.ts` | |
| 11 | `@Idempotent()` routes: `withIdempotency` around steps 12 and 13 | `src/protection/idempotency.ts` | 400 `idempotency_key_required`, `invalid_idempotency_key`; 422 `idempotency_key_reused`; 409 `idempotency_key_conflict` |
| 12 | Validation: the `params`, `query` and `body` of the route's `@ApiRoute`, checked between steps 9 and 10, on the body read, so that a bad input opens no transaction; then the pipe, for a `{ schema }` given to `@Body`, `@Param` or `@Query` (Zod) | `src/route-validation.ts`, `src/validation.ts` | 400 `validation_failed`, `details.fields` |
| 13 | The module's handler: `currentTenant()` is the workspace and the principal; the database's `app.workspace_id` matches | module | its own codes |
| 14 | Error filter: every error of steps 2 to 13 becomes `{ code, details }` | `src/error-filter.ts` | 500 `internal_error` otherwise |

A module's webhook, `POST /v1/<module>/webhooks/<provider>` (README "Modules"), is answered between steps 3 and 4 by `src/webhooks.ts`: its rate limit per address, its raw body within the module's `bodyLimit`, the module's `receive`, 204; no session, workspace or tenant run; its errors go through step 14.

A route outside the workspaces, a module's `accountApi` under `/v1` (tenancy's `GET /v1/me`), skips steps 6, 7, 10 and 11 and needs a principal only, unless it declares a permission; its handler reads the principal from `req.principal`, which step 5 leaves there.

## The request log line

One line per request, `msg: "api: request"`, when the response closes: `request_id`, `method`, `route` (the template, `/v1/workspaces/:workspaceId/fixture`, absent when no route matched), `status`, `duration_ms`, `workspace_id` (after step 6), `outcome: "aborted"` when the client left first, and the trace and span ids when telemetry runs. Never the URL, its query string, a header, a cookie or a body. A 5xx adds a line `api: request failed` with the error's type, code and frames.
