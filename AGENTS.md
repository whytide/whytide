# Whytide: the brief for contributors and coding agents

Read this first, then only what your task names. Whytide is one pnpm workspace in TypeScript, laid out as [docs/architecture.md §4.1](docs/architecture.md#41-workspace-layout) says: hosts in `core/apps/`, one module per feature in `core/modules/`, the shared packages in `core/packages/`, the enterprise list in `ee/`, Compose and the environment in `deploy/`.

## The rules

Every change follows the three rules files. They are not advice; where they and the architecture differ, the architecture wins.

- [docs/rules/coding.md](docs/rules/coding.md): where code goes, module boundaries, registries instead of central lists, data, configuration, style, tests.
- [docs/rules/security.md](docs/rules/security.md): the red lines, personal data, tenants, secrets, requests and egress, AI, the supply chain, conduct.
- [docs/rules/delivery.md](docs/rules/delivery.md): one task, one worktree, one branch, one module; the checks before a merge request; the merge request; done.

Decisions are recorded in [docs/adr/](docs/adr/), one file per decision.

**Alpha speed mode.** Until the alpha ships, [delivery §7](docs/rules/delivery.md#7-alpha-speed-mode) relaxes the process so that a task finishes and the next ones can start:
- about 1,500 lines per merge request;
- the task's own checks, without the full pipeline;
- one quick review, for blockers;
- one dependency merge request per task;
- a task's `.http` file under `api-calls/` written, not run.

What it defers is written down and done before the alpha ships. Where it differs from any of the following, it wins:
- this file;
- the other sections of the delivery rules;
- architecture §19;
- the tools/ci README;
- two lines of the security rules: one dependency per merge request, and two reviews.

Every other security rule holds in the code, and a dependency merge request still runs `deps:check`.

## Commands

Node 26 (`.node-version`); any pnpm 10 or later switches to the version pinned in `package.json`.

| Command | What it does |
|---|---|
| `pnpm install --frozen-lockfile` | installs exactly what the lockfile says, and the pre-commit hook that keeps secrets out of commits; the lockfile changes only in a merge request that adds a dependency |
| `pnpm build` | `pnpm -r --if-present build`: builds every workspace package in dependency order |
| `pnpm typecheck` | `pnpm -r --if-present typecheck`: type-checks every package with TypeScript project references (`tsc -b`, incremental) |
| `pnpm lint` | `pnpm -r --if-present lint`: the structural rules of [tools/lint](tools/lint/README.md) on every package; `node tools/lint/lint.ts --fix <paths>` applies the fixes they offer |
| `pnpm test` | `pnpm -r --if-present test`, one package at a time, then `tests/skeleton.test.sh`, the end-to-end test of the skeleton |
| `pnpm format` | formats the code and orders the imports with Biome (`biome check --write`); never hand-format |
| `pnpm format:check` | the same without writing; what the pipeline runs |
| `pnpm module:new <name>` | copies `core/modules/_template` to `core/modules/<name>`; then `pnpm install` registers it |
| `pnpm changeset` | writes a changeset under `.changeset/`; every merge request carries one |
| `pnpm stack:up`, `pnpm stack:status`, `pnpm stack:down [--wipe]` | the shared development stack, one Compose project per laptop: Postgres, Redis, Temporal, MinIO and Mailpit, plus `--profile observability` and `--profile tools` ([deploy/README.md](deploy/README.md)) |
| `pnpm env:create [name] [--force]`, `pnpm env:status`, `pnpm env:destroy` | the worktree's slice of that stack, the first two commands of any task: `env:create` once the worktree exists (its database, Temporal namespace, Redis prefix, bucket and ports, written to `.env.local`), `env:destroy` after the merge ([deploy/README.md](deploy/README.md)) |
| `pnpm ci:local [step...] [--labels <labels>] [--no-cache]` | the full pipeline of [delivery §4](docs/rules/delivery.md#4-before-the-pull-request) on this laptop: the steps of [tools/ci/steps.json](tools/ci/steps.json) in order, each as `pnpm -r --if-present <step>`, a step no package defines reported as skipped, a package whose inputs did not change since the step last passed left out; `--labels` carries the merge request's labels to the branch checks ([tools/ci/README.md](tools/ci/README.md)) |

Per package: `pnpm -F <name> <script>`, where `<name>` is the folder name, for example `pnpm -F platform typecheck`. Every package exposes the same script names, `lint`, `typecheck`, `test`, `test:e2e`, `test:contract`, `test:tenancy`, `test:roles`, `test:replay`, `build`, `smoke`, `messages:check`, `docs:check` and `eval`, defining the ones that apply to it, so the pipeline calls `pnpm -r --if-present <script>`, within the folders a step's `only` names in [tools/ci/steps.json](tools/ci/steps.json) (`smoke`: `deploy`), and no other central list exists.

## Lint rules

`pnpm lint` fails on these, so no reviewer has to catch them by eye ([tools/lint/README.md](tools/lint/README.md) has the details and how to add a rule):

| Rule | Protects |
|---|---|
| `module-boundaries` | a module imports another module only as `@whytide/<name>`, its `index.ts`; never a host, never another module's Prisma client; `core/` never imports `ee/` |
| `no-framework-in-domain` | `domain/` is plain TypeScript: nothing from NestJS, Next.js, Prisma, Temporal or Mastra |
| `vendor-sdk-in-adapter-only` | a vendor SDK listed in `tools/lint/vendor-sdks.json` is imported only inside its adapter folder; an adapter task adds its entry |
| `mastra-in-ai-only` | `@mastra/*` is imported only in `core/packages/ai` (a module's `agents/` imports `@whytide/ai`); Mastra's Enterprise Edition code (an `ee` path, `@mastra/core/auth`, `@mastra/core/license`, a package's `dist/`) nowhere |
| `no-literal-strings-in-screens` | under `ui/` and `core/packages/ui`, JSX text and the string props a person reads come from the i18n runtime, never from a literal |
| `no-raw-fetch` | only `core/packages/platform/http` and the adapter folders reach the network directly: elsewhere no global `fetch` or `WebSocket`, no client side of Node's `http`, `https`, `http2`, `net`, `tls`, `dgram` or `dns`, no client package such as `axios`, `undici` or `got`; test code may use `fetch` and Node's modules |
| `no-todo-without-task` | a `TODO` comment carries the ID of the task that will do it, like `alpha-p3-020` |
| `decrypt-in-worker-only` | the worker decrypt entry `@whytide/platform/secrets/worker` is imported only under `core/apps/worker/` and a module's `workflows/`, and a module's `workflows/` (its own decrypt entries, linkedin's `withDecryptedRef`) only from there and the module's `tests/`; the api encrypts with `encryptSecret` from `@whytide/platform` and never decrypts |
| `prompt-file-header` | every prompt file of an agent, `agents/<agent>/prompt.v<N>.md`, starts with the data-block header: the blocks the input arrives in, and the sentence that marks them as data, never instructions |
| `logical-css-properties` | a stylesheet uses logical properties and values (`margin-inline-start`, `text-align: start`), never the physical ones (`margin-left`, `text-align: left`), so right-to-left languages need no rewrite |
| `logical-utility-classes` | a className uses Tailwind's logical utilities (`ms-2`, `ps-4`, `start-0`, `text-start`, `border-s`, `rounded-s`), never the physical ones (`ml-2`, `pl-4`, `left-0`, `text-left`, `border-l`, `rounded-l`) |
| `workflow-input-ids-only` | a workflow or activity input under a module's `workflows/` carries ids only: no field named in the PII registry or after a `/// pii` column |

## Conventions

- A module has the shape of [core/modules/_template](core/modules/_template/README.md) ([architecture §4.2](docs/architecture.md#42-inside-a-module)); `pnpm module:new` creates one. Its `index.ts` is its public interface and the only importable file. Its `AGENTS.md` points you at its README, its docs and its commands.
- Hosts hold no feature code. Their module lists are generated at build into `*.generated.ts` files, which git ignores; no generated file is ever committed (`*.generated.*`, `openapi.json`, the Prisma client).
- Configuration is environment variables, listed in `deploy/.env.example` in one headed block per package and module. `.env.local` is written by `pnpm env:create`, is yours and never committed; a secret never enters the repository.
- Before the pull request: `pnpm ci:local` when your task is the first or the last of its folder, or whenever you want the full pipeline on your laptop ([delivery §4](docs/rules/delivery.md#4-before-the-pull-request)); its `docs:check` wants a docs change in every module you changed, or the label `docs-not-needed`, and its `changeset:check` a changeset, or the label `no-changeset`. The GitLab pipeline never runs by itself: a person triggers it, on the pushed branch of the first and the last task of each priority folder, and for no other task ([tools/ci/README.md](tools/ci/README.md)).
- A new dependency is its own merge request with the label `dependency` and the reason; `pnpm add` refuses a version younger than seven days and a dependency with an install script until a reviewer lists it under `allowBuilds` ([docs/adr/0002-supply-chain.md](docs/adr/0002-supply-chain.md)). A secret never enters a commit: the hook rejects it, `secrets:scan` finds it in a branch's history, and no schema field or log key is named like a password, a cookie or a second-factor secret ([tools/ci/README.md](tools/ci/README.md)). A vulnerability is reported as [SECURITY.md](SECURITY.md) says, never in an issue.
- An endpoint added or changed comes with its requests in [api-calls/](api-calls/README.md): one `.http` file per task, `<task ID>-<slug>.http`, one request per endpoint with an example body, written with variables, never a secret.
- A merge request changes one module or package, stays under about 700 lines, carries a changeset, touches the docs or says `docs-not-needed`, answers the questions of `.gitlab/merge_request_templates/default.md`, and carries the `ai-generated` label when an agent wrote it. Never weaken a check to make it pass.
- Every route carries `@ApiRoute({ summary, params, query, body, response, errors })`, which validates its input and documents it (a module writes `SetMetadata("whytide:api-route", { … })`); `pnpm openapi:build` fails on a mounted route without one or without a request in `api-calls/*.http` ([core/apps/api/README.md](core/apps/api/README.md#openapi-and-the-client)).
