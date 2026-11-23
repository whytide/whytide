# Coding rules

| | |
|---|---|
| **Purpose** | What every implementer, human or coding agent, follows on every task. Condensed from the [architecture](../architecture.md) and, in the private planning repository, docs/15 and docs/16. Where this file and those differ, the architecture wins. |
| **Read with** | [security](security.md) · [delivery](delivery.md) |

Paths are relative to the code repository's root.

## 1. Where code goes

```
core/
  apps/web  apps/api  apps/worker     hosts: they mount the modules and hold no feature code
  modules/<name>                      one per feature
  packages/platform                   principal and permissions, the credits client, events, config, ids, the i18n runtime, the egress client
  packages/db                         Prisma: one schema file per module, migrations, roles
  packages/providers                  the ports and their adapters
  packages/ai                         the Mastra setup, the task registry, the eval runner
  packages/ui                         shared components, tokens, shared messages
deploy/                               compose.yaml, Caddyfile, .env.example, scripts
```

Every module has the same shape ([architecture §4.2](../architecture.md#42-inside-a-module)):

```
core/modules/<name>/
  README.md  AGENTS.md  index.ts
  domain/  schemas/  api/  workflows/  agents/  ui/  messages/  docs/  tests/
  permissions.ts  prices.ts  events.ts  settings.ts
```

- A task changes one module or one package. A change to `platform`, `providers`, `ai`, `db` or `ui` is its own task and merges before the modules that use it.
- Alpha's modules: tenancy, identity, onboarding, icp, signals, qualification, discovery, contacts, messaging, linkedin, credits. Each host's module list is generated from the folder at build, never committed.
- `ee/` is empty in alpha. `ee/` imports `core/`, never the reverse.

### constants
DO NOT hard code anything in code files, instead keep constants/variables in separate files like constants.ts

## 2. Boundaries

1. Import another module only through its `index.ts`. Never from its `domain/`, `api/`, `agents/` or tables.
2. Read another module's data through the public queries in its `index.ts`; change it only through its public commands or by publishing an event it subscribes to. No module writes a table it does not own; the owner is the schema file the table sits in.
3. Modules depend on `platform`, `providers`, `ai` and `db`. Never on a host, never on another module's internals.
4. Events are written in the same transaction as the change, in the outbox table, and delivered by the worker.
5. The lint rule enforces 1 to 3. A violation fails the lint; do not work around it.
6. A cross-cutting change (a field on the principal, a new port, a shared component) goes to the package first, in its own pull request.

## 3. Registries, not switchboards

Anything that lists "all the X" is assembled from one file per module. If a feature makes you edit a central enum, switch or list, stop: the fix is a registry.

| List | Declared in | Assembled by |
|---|---|---|
| Permission actions | `permissions.ts` | `platform`, at start |
| Prices | `prices.ts` | the credits module, at start |
| Events | `events.ts` | `platform` |
| API routes | `api/` | the api host, from a generated list |
| Workflows and activities | `workflows/` | the worker host, from a generated list |
| Screens and navigation | `ui/` with a `nav.ts` entry | the web host |
| Messages | `messages/<locale>.json` | the i18n build |
| Settings and provider keys | `settings.ts` | config files in alpha; the settings screen later |
| Signal source kinds | `modules/signals/sources/<kind>/` | the signals module, at start |
| Tables | `packages/db/prisma/schema/<module>.prisma` | Prisma |

## 4. Inside a module

**`domain/`** holds the rules in plain TypeScript: no import from NestJS, Next.js, Prisma, Temporal or Mastra. Pure functions where possible. Scores, filters, gates, state transitions and validations live here, so the API and the worker run the same code, and this is where the unit tests go ([§11](#11-tests)).

**`schemas/`** holds the Zod request and response schemas. The OpenAPI 3.1 document and the web client are generated from them at build and never committed. Database types come from Prisma; the mapping between the two lives in `api/`, never in the web app.

**`api/`** is a NestJS module: thin controllers, services that call `domain/`. Every handler runs with a principal and a tenant context; the workspace comes from the URL. Errors are machine codes (`icp_not_found`, `insufficient_credits`), never sentences; the UI translates them. A write that spends credits or calls a provider takes an idempotency key. Every endpoint has a request in a `.http` file under [`api-calls/`](../../api-calls/README.md) at the repository root, one file per task, `<task ID>-<slug>.http` (the VS Code REST Client and JetBrains HTTP Client format). The file holds one request per endpoint with an example body. It uses the variables `{{baseUrl}}`, `{{workspaceId}}` and `{{sessionCookie}}`, whose values are in `api-calls/http-client.env.json` and its git-ignored private twin. It never holds a committed secret. The file changes in the same pull request as the endpoint and, once run, is the manual check for it.

**`workflows/`** holds Temporal workflows and activities. Workflows orchestrate only and carry IDs, never personal data. Activities do the work: rules, ports, agents, the database. Activities are idempotent, because Temporal retries them. Schedules replace cron. Alpha has two workflows: the signal run and the qualification batch.

**`agents/`** holds the module's agent tasks with their prompts, on `@whytide/ai`. The rest of the module calls an agent through a plain function with Zod input and output; only `core/packages/ai` imports Mastra. Models come through the LLM port. Input is anonymized and delimited ([security §6](security.md#6-ai)); output is structured and validated. Mastra memory stays off: context comes from our tables, per call. Every agent is registered in the task registry of `packages/ai` (model, prompt version, schema, budget), and every call writes a decision record and a cost event. One agent per job; versions pinned. Agents run in the worker; the API never calls a model.

**`ui/`** holds Next.js route segments and components. Screens call the API through the generated client only, never the database. No string literal in a screen: every string is a key in `messages/en.json`, in ICU syntax, named `module.screen.purpose`. Dates, numbers and currencies go through the i18n runtime's `Intl`, never hand-formatted. Logical CSS properties (`margin-inline-start`, not `margin-left`). Shared words (Save, Cancel) come from `packages/ui` messages.

**`messages/`**: humans edit `en.json` only. The message-key check fails on a used key that does not exist, an unused key or invalid ICU.

**`docs/`**: `concepts.md`, `data.md`, `flows.md`, `runbook.md`, `security.md`. The `README.md` says what the module owns and exports; `AGENTS.md` points a coding agent at the README, the docs and the commands. Docs change in the same pull request as the behavior.

## 5. Data

- One Prisma schema file per module, `packages/db/prisma/schema/<module>.prisma`. Table names in `snake_case` as [architecture §7](../architecture.md#7-data) lists them.
- One migration per pull request, named `<module>_<change>`. What Prisma cannot say (roles, triggers, pgvector and full-text indexes, later the policies) is hand-written SQL inside the same migration, with a comment in the schema file pointing at it. Migrations run at start, expand first, and stay compatible with the previous release.
- `workspace_id` on every tenant row and in every unique key. Organization rows carry `organization_id`. A sharing group's rows carry `sharing_group_id`, the run's (tenancy's `sharingGroupOf()`), never one a caller names. Global tables hold no person data.
- IDs are `<prefix>_<ULID>` (`per_…`, `lead_…`), generated by `platform`. External IDs from providers sit in their own columns or in `provider_refs`, never in domain columns.
- Instants in UTC. A local schedule is an IANA time zone plus local clock times.
- Every person-data value carries its provenance (source class, provider, fetched time) and a PII class. A value without provenance is a bug.
- Ledgers, decision records and the audit log are append-only. The exceptions are a reservation's state and the balance row.
- Redis holds nothing durable: locks, rate limits, caches. Quotas and credits live in Postgres.
- Files go through the files port only (the S3 API), under a path prefixed by the workspace.

## 6. Ports and adapters

Every external system sits behind a port ([architecture §9](../architecture.md#9-ports-and-adapters)):

1. The port is written in our words, in `packages/providers/<port>/port.ts`: our types, our error codes, our units. A vendor's object never crosses it.
2. One adapter per folder, `packages/providers/<port>/<vendor>/`. The vendor SDK is imported only there; the lint rule blocks it everywhere else.
3. A registry maps names to adapters; server config or the organization's settings pick one. Nothing else knows which is running.
4. Every adapter passes the same contract test suite. A fake adapter implements each port in a few dozen lines, and the unit tests and the Compose smoke test run on the fakes. Write the fake with the port, before the vendor adapter.
5. Vendor IDs live in `provider_refs` or the adapter's own table, keyed by adapter name.
6. Adding a provider is a folder, a registry entry and a docs page. Nothing shared changes.

The API tests a provider key on save, before it is stored. Alpha's ports: authentication, LLM, LinkedIn, files, app mail.

## 7. Credits

A priced action declares its price in `prices.ts` and runs as reserve, work, then commit or release, with an idempotency key and the actor ([architecture §10](../architecture.md#10-credits)). Insufficient credits is a clear error to the caller, never a silent skip. Nothing in `api/` or `workflows/` writes plans, subscriptions or grants; only the seeder does, as `billing_writer`.

## 8. Configuration

- Configuration comes from environment variables, listed in `deploy/.env.example` with defaults, one block per module with a header, in module order.
- Provider, model and thresholds live in config files in alpha. No admin screens.
- `.env.local` in a worktree is never committed. Development keys carry a small spending cap.
- In development every email the app sends (sign-in links, invites, alerts) goes to **Mailpit** through the SMTP adapter of the app-mail port; `.env.example` points there by default. A test or a person reads the message from Mailpit's inbox or API. No real mail leaves a development environment.

## 9. Logs, traces and errors

- OpenTelemetry on every host; one trace from the request through the workflow and the agents inside it. OTLP is the only output, and only when a collector address is set.
- Logs are JSON through pino, with the trace and span IDs. Logs, spans, metrics and error reports carry IDs, counts and durations: never a name, an email, a person's URL, a message body, a token or a key. A test checks the log schema.
- Every provider and model call emits a cost event: workspace, feature, task, vendor, model, units, price-list version.
- A failure is an error with a machine code and enough IDs to find it, never a swallowed exception. Retries use backoff with jitter; after the last attempt the item goes to a dead-letter state with an alert.

## 10. Style

- TypeScript strict, the current Node LTS. The formatter decides formatting and import order; never hand-format.
- Names from the glossary (docs/12, in the planning repository): person, lead, signal, source, sender account, Company Knowledge, ICP. One word per thing across the code, the API, the screens and the docs.
- Small files and small functions. A comment says why, not what. No `TODO` without a task ID. No dead code; unfinished work ships behind a flag, never on a long branch.
- Few dependencies: prefer the platform and the frameworks already present. A new dependency is its own small pull request with a reason (in the alpha, one per task: [delivery §7](delivery.md#7-alpha-speed-mode)), under MIT, BSD, Apache 2.0 or the PostgreSQL license, pinned. Generated files are never committed.
- Test data is synthetic. Fixtures live per module; shared factories in `platform`.

## 11. Tests

- **Every task ships an end-to-end test** that proves its acceptance criteria from the outside: through the screen with Playwright when the task has one, otherwise through the API or the worker, on the fake adapters, against the worktree's database. For a package, the test uses it the way its consumers do (a migration on a real database, the egress client against a local server).
- **Unit tests only for business logic** worth isolating: scores, filters, gates, state transitions, parsers, the credit state machine. No unit tests for wiring, mappings, getters or screens; the end-to-end test covers those.
- A new adapter gets the port's contract test suite. A new tenant table gets the two-workspace isolation test. A new workflow gets a replay test. A changed prompt runs its evals.
- Tests run on the fakes and synthetic data. A test never calls a vendor, never needs a secret, and never depends on another test's state.
