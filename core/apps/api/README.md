# @whytide/api

The NestJS host: it runs the migrations, mounts every module's `api` from a generated list, answers `GET /health`, and runs each request for one principal in one workspace. It holds no feature code (docs/rules/coding.md §1, §4). The request path, step by step: [docs/request-path.md](docs/request-path.md).

## Commands

| | |
|---|---|
| `pnpm -F api dev` | builds once, then `tsc -b --watch` beside `node --watch dist/src/main.js` |
| `pnpm -F api build` | the generated files (db's, providers', ai's, signals' kinds and the module list), every module's build (`modules:build`, `tsc -b` of each listed module), then `tsc -b` to `dist/` |
| `pnpm -F api start` | `node dist/src/main.js` |
| `pnpm -F api test` | builds, then `node --test` on `dist/tests/` against the worktree's database; the build builds every module first, so a test that loads a module's `dist/` by path, as the host does a module with a screen (credits, signals, messaging), loads a current one |
| `pnpm -F api smoke` | `GET /health` at `API_PUBLIC_URL` (or `http://127.0.0.1:API_PORT`): exits 0 on 200 only; `pnpm smoke` runs it, then each module's `smoke` script, identity's sign-in among them |
| `pnpm -F api serve:e2e` | the api of the web's Playwright tests on `API_PORT` (`tests/e2e-server.ts`): `APP_ENV=test`, tenancy (`FEEDBACK_URL` set) and identity, whose resolver reads the memberships, the fixture module's routes and the modules whose screens the tests open (icp, onboarding, with the test-only `POST /test/onboarding/draft/<outcome>` of `tests/e2e-onboarding.ts` writing `wsp_e2e_c`'s record as the drafter leaves it, `drafted` or `failed`, linkedin, with the LinkedIn fake's connect route mounted, signals, with the sender accounts and the test-only `POST /test/signals/runs` of `tests/e2e-signals.ts`, and discovery, with contacts and a fixed hash salt; qualification, for the lead page's snapshot read; credits, for the header's balance, its costs page and the lead page's cost line; and the test-only `e2e` module of `tests/fixtures/e2e/`, whose `POST …/e2e/leads` replaces a workspace's leads through contacts' commands, a lead's snapshot and verdicts with them, `POST …/e2e/spend` reserves and commits credits, once per `key` when given, and `POST …/e2e/costs` replaces the workspace's cost events), Better Auth with its links on the web (`AUTH_BASE_URL`) beside the fake's test route, `e2e@example.com`, `e2e-usage@example.com` and `e2e-states@example.com`, each its own user and an Owner of every e2e workspace (`wsp_fixture_a`, `wsp_e2e_b`, `wsp_e2eimport`, `wsp_e2e_c`, `wsp_e2e_review`, `wsp_e2e_qual`, `wsp_e2e_rescore`, `wsp_e2e_export`, `wsp_e2e_evidence`, `wsp_e2e_signals`, `wsp_e2e_run_now`, `wsp_e2e_contacts`, `wsp_e2e_noleads`, `wsp_e2e_url`, `wsp_e2e_drafts`, `wsp_e2e_costs` and `wsp_e2e_nocosts`, one spec's each), `APP_PUBLIC_ORIGIN` the web's origin; `tests/e2e-hold.ts` holds a `GET` for three seconds when its path ends with the value of the request's `e2e_hold` cookie, so that a spec sees a screen's loading state while the web's server reads |
| `pnpm modules:generate` | writes `src/modules.generated.ts` (git-ignored) |

## Start

`main.ts` loads `.env.local` (when there is one), starts telemetry, then imports `start()`, which:
1. runs the migrations as the owner (`runMigrations`); a failure logs `migration_failed` with `migration`, the migration's name, and the process exits 1 without listening;
2. loads the modules and awaits each one's `onStart`, makes the `app` and owner clients, picks the authentication adapter (`PROVIDER_AUTH`), passes it the `authHooks` export ("Modules") and builds the app;
3. listens on `API_PORT`, at `127.0.0.1`, or `0.0.0.0` under `APP_ENV=production`.

`SIGTERM` and `SIGINT` close the app, the clients and telemetry. A test calls `start({ port: 0, modules, clients, migrations, log })`; `mount` adds connect-style handlers ahead of the routes, as the e2e api does with the LinkedIn fake's connect route.

## Modules

`pnpm modules:generate` lists every `core/modules/<name>/index.ts` (not `_` or `.` folders), with no edit to the host: a module joins the api by existing. The host imports each module's build, `dist/index.js`: the api's `build`, which `dev`, `test` and `openapi:build` run, first builds every listed module (`modules:build`), and `dev` then watches only the modules the api's tsconfig references. Loading registers what the module declares (`permissions`, `events`, `errors`, `ids`, `settings` call the platform's `define*` as they load). The host reads six exports:
- `api`: a NestJS `@Module` class, mounted under `/v1/workspaces/:workspaceId/<name>`; its controllers need `experimentalDecorators` and `emitDecoratorMetadata`;
- `accountApi`: a NestJS `@Module` class mounted under `/v1`, for the routes outside the workspaces (tenancy's `GET /v1/me`): the principal guard only, no workspace, tenant run or permission unless declared; a handler reads the principal, read-only, from `req.principal`. It is never the `api` class itself: NestJS keeps one path per class;
- `workspaceResolver`: `({ principal, workspace }) => Promise<{ workspaceId, membershipId, role } | null>`, `workspace` being the URL's id or slug: identity's, which asks tenancy on every request. One module at most exports it; without one every workspace route answers 403 `forbidden`;
- `authHooks`: `{ allowSignIn, mail, users }`, the authentication port's `AuthHooks`, which `start()` passes to the adapter's `configure()` before it listens: identity's, the invite-only rule. One module at most exports it; without it the adapter gets no hooks, and the fake refuses every email;
- `webhooks`: `{ bodyLimit, receive({ provider, headers, rawBody }) }`, mounted at `POST /v1/<name>/webhooks/<provider>` ahead of the routes, for a vendor's calls: no session, no workspace, no tenant run, no OpenAPI entry. The host limits it per address (`RATE_LIMIT_WEBHOOK_PER_IP_PER_MIN`, docs/security.md), reads the raw body up to `bodyLimit` bytes (an integer, 1 MB at most) and hands it to `receive`, which checks the vendor's signature and finds its account itself; 204 when it resolves, its error's status otherwise. linkedin's;
- `onStart`: `({ log }) => Promise<void>`, awaited in the modules' order after the migrations and before the api listens (credits seeds its plan there, as `billing_writer`). A throw stops the start with `module_invalid`, `details.field` `onStart` and the error as its cause.

A bad export stops the start with `module_invalid` (`details.module`, `details.field`); a second resolver or `authHooks` with `duplicate_registration` (`details.field`, `details.sources`). Settings that fail as a module loads stop it with the platform's `config_invalid` itself, which names the block and the variables, whichever module imported them first. Every controller sits in a module the host mounts: an `api` or `accountApi` that imports a NestJS module with controllers would serve them at their own paths, past the workspace and permission guards, so the start stops with `module_invalid` (`details.field: "controllers"`, `details.nestModule`). Only the host's own routes skip the session: `@Public()` sets a symbol, so a module's `SetMetadata("whytide:public", true)` marks nothing.

## Permissions

Every workspace route declares its action: `@Permission("leads.read")` (`src/permission.ts`), on the handler or the controller, sets the metadata `whytide:permission`, which the permission guard checks with `can()` after the workspace guard. A workspace route without one answers 500 `permission_undeclared`. A module cannot import the host: it writes `SetMetadata("whytide:permission", "<action>")` from `@nestjs/common`. `can()` checks the member's role, read from the membership on every request, against the action's declared roles: a Member is 403 `forbidden` on a route whose action lists only Owner and Admin (`tests/roles.test.ts`); `tests/fixtures/permission-table.txt` holds every module's actions and roles, which `tests/permission-table.test.ts` compares with the declarations (platform README, "Principal and permissions").

## Health

- `GET /health` runs every registered check, each with a 2-second timeout: 200 `{ status: "ok", version, checks }`, or 503 with `status: "failing"` and `failing`, the names of the failing checks. The version is the api package's.
- `GET /health/live` answers 200 `{ status: "ok" }` and runs no check.
- Both are public, `cache-control: no-store`.

The registration point is `registerHealthCheck(name, create, import.meta.url)` in `src/health.ts`: `create` gets the host's `app` and owner clients, its Redis client and the migrations count at start, and returns the check, an async function that throws when failing. A name registered twice stops the start with `duplicate_registration`. Registered here: `database` (`SELECT 1` as `app`) and `migrations` (none failed or unfinished, none of those applied at start gone; read as the owner, since `app` cannot read `_prisma_migrations`). `redis` (`PING`) is registered in `src/protection/redis.ts`; Temporal (alpha-p2-050) registers its own with its client.

## Errors

The answer to an error is `{ code }`, plus `details` below 500 only; never a message or a stack trace. An `AppError` keeps its code's status. NestJS's HTTP errors, the body reader's among them, answer `not_found` (404), `payload_too_large` (413) or `invalid_request` (other 4xx); anything else is 500 `internal_error`, logged with its type and frames. The host's codes (`src/errors.ts`) are developer-facing, without message keys: `validation_failed` (400, `details.fields`: the paths at fault), `internal_error`, `permission_undeclared`, `workspace_resolver_invalid`, `migration_failed`, `module_invalid`, `duplicate_registration` (500).

## Configuration

The `apps/api` block of `deploy/.env.example`: `API_PORT` (default 3001; `pnpm env:create` fills one per worktree) and `API_PUBLIC_URL`, the URL the api is reached at from outside, optional.

## Decided here

- Express under NestJS (`@nestjs/platform-express`), with `x-powered-by` off; NestJS 12.1.3, not 11.
- `tsc -b` to `dist/`, not one bundle: an esbuild bundle loses the decorator metadata and NestJS's telemetry spans. Node 26 cannot run decorated `.ts`, so the tests run on the compiled output.
- `experimentalDecorators` and `emitDecoratorMetadata` in this package's `tsconfig.json` only; Biome parses parameter decorators (`javascript.parser.unsafeParameterDecoratorsEnabled`).
- NestJS's telemetry needs pnpm's default hoisting: keep it.
- The request log goes through the platform logger, never pino-http (`req.url` carries the query).

## Sign-in

The host's own routes in front of the authentication port (`src/sign-in.ts`), which a module cannot mark public:
- `POST /v1/sign-in` `{ email, next? }`, public: 202 with no body to every well-formed email, invited or not; the port's `requestMagicLink` runs once the answer is sent, so neither the status, the body nor the time tells an invited email from another. `next`, where the link lands, is checked with the port's `authRedirectPath`, else `/`, the web's first workspace. Rate-limited per address and per email ([docs/security.md](docs/security.md)); a failure after the answer is logged by its code only.
- `POST /v1/sign-out`, with a session: the port's `signOutEverywhere` for the user, then the session cookie cleared (`Max-Age=0`); 204.

## Request protection

[docs/security.md](docs/security.md) has the protections and their settings: rate limits in Redis per workspace and per address (429 `rate_limited`, `Retry-After`), the origin check of a cookie-carrying change (403 `origin_rejected`), the security headers, idempotency keys, and the body limits (1 MB of JSON, 413 `payload_too_large`). `start()` connects to `REDIS_URL` after the authentication adapter, waiting 2 s at most, and `GET /health` reports it as `redis`. A test may pass `start({ redis, now })`: its own client, and a clock for the rate limits.

A handler declares, with the decorators of `src/protection/index.ts` or, in a module, `SetMetadata(key, value)`:

| Decorator | Metadata | Effect |
|---|---|---|
| `@Idempotent()` | `whytide:idempotent`, `true` | needs `Idempotency-Key` (a UUID); a replay answers the stored status and body, with `Idempotent-Replayed: true` |
| `@BodyLimit(bytes)` | `whytide:body-limit`, bytes | the route's body limit, in place of 1 MB |
| `@Multipart()` | `whytide:multipart`, `true` | lets `multipart/form-data` through, unread, for the route's own parser |
| `@OwnRuns()` (`src/workspace.ts`) | `whytide:own-runs`, `true` | no tenant run around the handler, which reads `req.tenant` and opens `withTenant(req.tenant, …)` for each database step: for a route that reads its body as a stream or calls a provider (alpha-p5-030); not with `@Idempotent()`, which runs in the run |

## OpenAPI and the client

Every mounted route carries `@ApiRoute({ summary, params, query, body, response, errors })` (`openapi/route.ts`), with the Zod schemas of the module's `schemas/`. It validates and documents in one place:
- **Validation**: after the body reader, so that its 413 and 415 come first, and before the tenant run, the route's own path parameters, its query and its body are checked; 400 `validation_failed` with `details.fields`; the handler reads the parsed values. `workspaceId` stays the workspace guard's. A `@Multipart()` route declares no `body`: the reader leaves that body to the route, unchecked and undocumented (alpha-p5-030).
- **Document**: `pnpm openapi:build` writes the OpenAPI 3.1 document to `openapi.generated.json` (git-ignored) from the routes NestJS mounts, validates it with Redocly's `minimal` rules, runs the `.http` coverage check (below) and the secret-shape check of `tools/ci` on it. Each route answers its `response`, and `{ code, details }` per error status with its codes: the route's `errors`, plus `auth_session_invalid` (401) unless `@Public()`; `forbidden` (403) and `rate_limited` (429) under a workspace; `origin_rejected` (403) on any method but GET; `validation_failed` (400) when there is an input; the body reader's `invalid_request` (400 and 415) and `payload_too_large` (413) when there is a `body`.
- **Failures** (developer-facing codes, `openapi/errors.ts`): a mounted route without `@ApiRoute` is `openapi_route_undocumented` naming the routes; a schema JSON Schema cannot say (a date, a transform's output, an `id` or a cycle, which would need a `$ref`) is `openapi_schema_unsupported`; a cookie or authorization header parameter, or an example under such a name, is `openapi_secret_example`.
- **Extra headers**: `@ApiHeader({ name, required, schema })` documents a header the route reads; several stack. The document adds `Idempotency-Key` (required, a UUID) by itself to a route that carries the metadata `whytide:idempotent`, which `@Idempotent()` sets, with its codes: `idempotency_key_required` and `invalid_idempotency_key` (400), `idempotency_key_conflict` (409), `idempotency_key_reused` (422).

A module cannot import the host: it writes `SetMetadata("whytide:api-route", { … })` from `@nestjs/common`, the same object. The document has no `operationId`, `servers` or security scheme, and never a `$ref`: it is self-contained, so the validator and the client's generator read nothing but the file. The auth adapter's own routes (`/api/auth/*`, ahead of NestJS) are not in it. `pnpm client:generate` builds the document and then web's typed client (`core/apps/web/README.md`).

## The .http file

The requests of every endpoint live in `api-calls/<task ID>-<slug>.http` ([api-calls/README.md](../../../api-calls/README.md)); the fixture module's in `tests/fixtures/module/api/fixture.http`.
- **Coverage**: `pnpm openapi:build` fails with `openapi_route_without_request`, naming the routes, when a route has no request in `api-calls/*.http`; a request URL must start with `{{baseUrl}}`, or `{{workerHealthUrl}}` for the worker's `GET /health`, which the check skips.
- `pnpm http:run <file>`: runs each request in order against the worktree's api (`127.0.0.1:API_PORT` from `.env.local`, else the `dev` environment's `baseUrl`), and a `{{workerHealthUrl}}` one against the worker's health server (`127.0.0.1:WORKER_HEALTH_PORT`), with `APP_PUBLIC_ORIGIN` as `appOrigin`, the `Origin` a write request that sends the cookie needs (the origin check above); one line per request with the status and the request line as written; exit 1 on a status of 400 or more. Loopback only: the session cookie never leaves the laptop.
- `pnpm session:token <email>`: signs the email in through the fake authentication adapter's test route on the running api and writes the cookie to `api-calls/http-client.private.env.json` (git-ignored, mode 600) as `dev.sessionCookie`; it never prints it. It needs the api under `APP_ENV=test` and `PROVIDER_AUTH=fake` (`better-auth` is the default), and an email identity lets sign in: invited with `pnpm invite <email>`, or a member already.

## Metrics

`src/metrics.ts` (alpha-p10-060; [deploy/docs/observability.md](../../../deploy/docs/observability.md)): `api.requests` (method, route template or `unmatched`, status, the error code or `none`) and `api.request.duration` in seconds, counted when the response closes, as the request log line is written; `api.rate_limit.decisions` (kind, outcome) from the request protection.
