# tools/ci: the pipeline

`pnpm ci:local` runs the full pipeline of [delivery §4](../../docs/rules/delivery.md#4-before-the-pull-request) on a laptop, in one command; [`.gitlab-ci.yml`](../../.gitlab-ci.yml) runs the same steps in GitLab, only when a person triggers it. Nothing runs on a push or on a merge request: pipeline minutes are scarce, the laptop is the gate, and the first and the last task of a priority folder run the full pipeline before their merge request.

## Running it

| Command | Does |
|---|---|
| `pnpm ci:local` | every step of [`steps.json`](steps.json) in order, each as `pnpm -r --if-present <step>`; stops at the first failing step and names it, exit code 1 |
| `pnpm ci:local lint test` | the steps named only, in `steps.json` order |
| `pnpm ci:local --labels docs-not-needed,no-changeset` | the merge request's labels, for the branch checks (`CI_MERGE_REQUEST_LABELS` in GitLab) |
| `pnpm ci:local --no-cache` | every package of every step runs; no record is written |

A step runs in every workspace package that defines a script of its name, in dependency order; the root package's scripts are the recursive wrappers and never run. A step marked `"serial": true` in `steps.json` runs one package at a time: `test`, because the deploy tests bring up a stack and watch the laptop's Docker while the tests of `ci` run installs and containers of their own. A step no package defines yet is reported as `skipped`, never as failed, so the list below is complete before the checks exist. A package joins a step by defining the script; nothing here names a package, but `only`: a step with `"only"` runs in the folders it lists and nowhere else. `smoke` runs in `deploy` only, whose Compose smoke test builds the images and brings up a stack of its own; the api's, the worker's and identity's `smoke` scripts check an api and a worker already running, which the job never starts, and run against one with `pnpm smoke` and `pnpm -F worker smoke`. The report at the end has one line per step, `ok`, `cached`, `skipped`, `failed` or `not run`, with the time and the package count.

## The steps

| Step | Proves | Defines it today |
|---|---|---|
| `lint` | the structure holds ([tools/lint](../lint/README.md)) | the hosts, the modules, the packages |
| `typecheck` | the types hold (`tsc -b`) | the hosts, the modules, the packages, the tools |
| `test` | the package does what it says, its end-to-end test included | `lint`, `deploy`, `ci` |
| `test:safety` | the send path's safety cases pass | the packages on the send path (beta's tasks) |
| `test:contract` | every adapter passes its port's suite | alpha-p1-090 |
| `test:tenancy` | `workspace_id` on every tenant table, two-workspace isolation | alpha-p1-020 |
| `test:roles` | `app` cannot write a grant | alpha-p1-020 |
| `db:migrate:check` | migrations on a fresh database and on the previous release | alpha-p1-020 |
| `openapi:build` | the OpenAPI document generated, the client built | alpha-p2-020 |
| `messages:check` | every key exists, none unused, ICU valid | alpha-p1-080 |
| `docs:check` | every module changed on the branch changed its docs, or the label `docs-not-needed` | `ci`: [docs-check.ts](docs-check.ts) |
| `test:replay` | workflows replay | the modules with workflows |
| `eval` | the agent tasks pass their evals on the LLM fake, when a file under `core/modules/*/agents/` or `core/packages/ai/evals/` changed on the branch; otherwise it passes, saying so | `ai`: [evals/run.ts](../../core/packages/ai/evals/run.ts) |
| `smoke` | the Compose smoke test: up, migrate, health, sign-in | `deploy` alone (`only`): [tests/production.test.ts](../../deploy/tests/production.test.ts) |
| `secrets:scan` | no secret in the history; no schema field or log key shaped like one | `ci`: [secrets-scan.ts](secrets-scan.ts), [secret-shapes.ts](secret-shapes.ts) |
| `deps:check` | the audit, the license check, one new dependency per merge request | `ci`: [deps-check.ts](deps-check.ts) |
| `changeset:check` | the branch adds a changeset, or the label `no-changeset` | `ci`: [changeset-check.ts](changeset-check.ts) |

`test:safety` is the safety suite, the cases that prove the send path's protections on the fake adapters: the quota invariants, no action against a suppressed person, no double send on a retry, nothing sent without approval. A package's cases live in its `tests/safety/*.test.ts`, and the hosts' in `core/apps/worker/tests/safety/` and `core/apps/api/tests/safety/`. A package joins by defining a `test:safety` script that globs `tests/safety/*.test.ts`; the api's runs `dist/tests/safety/*.test.js` after its build. `test` never runs these cases, because every `test` glob reaches one folder deep (`tests/*.test.ts`, the api's `dist/tests/*.test.js`). A send-path merge request runs `pnpm ci:local test:safety` before it opens; a failing case fails the step, and the pipeline with it.

The branch checks look at every file changed since the branch left `main` (`origin/main` where the remote exists), committed or not, plus the untracked files. `docs:check` takes a change under `core/modules/<name>/` outside `tests/` and `docs/` as a change of behavior and wants a change under that module's `docs/` or to its `README.md` with it; `_template` is not a module. `changeset:check` wants a changeset under `.changeset/` added on the branch when anything changed at all.

## The cache

A package is left out of a step when the step passed on it with the same inputs: the files git tracks or would track in the package and in the workspace packages it depends on, the packages under `tools/`, the root configuration (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `.node-version`, `.npmrc`), the script's text, the Node and pnpm versions. An ignored file, a build output for one, is never an input. The records are one JSON file per step under `node_modules/.cache/whytide-ci/`; a failing step writes none, so it runs whole again. A step marked `"cache": false` in `steps.json` runs every time: the branch checks, the secret scan and the dependency audit, whose inputs are the branch's history and the registry's advisories rather than a package's files, `docs:check` and `messages:check`, which read every module's docs, screens and message files rather than the files of the one package that defines the script, `eval`, which reads every module's agents, and `smoke`, whose images are built from the whole repository, `core/` included, which deploy's inputs leave out. `--no-cache` ignores the records; removing the folder clears them. In GitLab that folder, the pnpm store (`.pnpm-store/`) and the build outputs are the job's cache, keyed on the lockfile.

## Supply chain

The alpha rules of [security §7](../../docs/rules/security.md#7-supply-chain-in-alpha), decided in [ADR 0002](../../docs/adr/0002-supply-chain.md):

- **The settings**, in `pnpm-workspace.yaml` (pnpm 12 reads none of them from `.npmrc`): `minimumReleaseAge: 10080`, so a version published less than seven days ago is not installed and `pnpm add` says so; `strictDepBuilds: true` with `allowBuilds: {}`, so a dependency's install script fails the install until its name is under `allowBuilds` as `true` (reviewed, runs) or `false` (installed without it), one line per package. The lockfile is frozen under `CI=true`, which pnpm does by itself and the job sets; `pnpm install --frozen-lockfile` is the install everywhere, and the lockfile changes only in a merge request that adds a dependency, which carries the label `dependency` ([coding §10](../../docs/rules/coding.md#10-style): its own small merge request, with the reason).
- **The pre-commit hook.** `pnpm install` runs the root's `prepare` script, `node tools/ci/secrets-scan.ts hook`, which points `core.hooksPath` at [hooks/](hooks/); the hook runs gitleaks over the staged changes and rejects the commit when a secret is in them, the secret redacted in the output. gitleaks runs from its image, `zricethezav/gitleaks:v8.30.1`, pinned by digest in [secrets-scan.ts](secrets-scan.ts), with the checkout mounted at its own path: nothing is installed, every laptop and the job scan the same way, and Docker must be running, as it is for the stack. The rules are [`.gitleaks.toml`](../../.gitleaks.toml): gitleaks' defaults plus an Anthropic key, a Unipile key or webhook secret, the app master key and a Postgres URL with a password; its only allowlists are [fixtures/secrets/](fixtures/secrets/) and the development stack's own password on a local address. A secret that was committed is removed from the history and rotated; the allowlist is never widened for it.
- **`secrets:scan`**: the same scan over every commit reachable from `HEAD`, then [secret-shapes.ts](secret-shapes.ts): no field of a `*.prisma` file and no key of a `log-schema.json` is named like a password, a cookie or a second-factor secret ([secret-shapes.json](secret-shapes.json) has the words and the one exception, `password_hash` in the auth adapter's schema file, with its reason). A package with a log-schema test keeps the keys it allows in a `log-schema.json` next to it, which is how this check reads them.
- **`deps:check`** ([deps-check.ts](deps-check.ts)): `pnpm audit --audit-level=high` against the registry's advisories, a network call; every package's license in the allow-list of coding §10 (MIT, BSD, Apache-2.0, PostgreSQL, or an SPDX expression that offers one of them) or in [license-exceptions.json](license-exceptions.json) with a reason, one entry per package; and, when the branch changes `pnpm-lock.yaml`, at most one new direct dependency, unless the merge request carries the label `dependency-update`: the update bot's, or an alpha task's dependency merge request ([delivery §7](../../docs/rules/delivery.md#7-alpha-speed-mode)).

## The GitLab pipeline

When to trigger it, and only then ([delivery §4](../../docs/rules/delivery.md#4-before-the-pull-request)): on the pushed branch of the first and the last task of each priority folder, once `pnpm ci:local` passed there. No other task triggers it, whatever it changes: pipeline minutes are scarce, and `pnpm ci:local` runs the same steps.

How: Build › Pipelines › Run pipeline; choose the branch; when the merge request carries `docs-not-needed` or `no-changeset`, add the variable `CI_MERGE_REQUEST_LABELS` with those labels, comma-separated (GitLab sets that variable itself only in merge request pipelines, which never run here); Run. A trigger token or the API works the same way; a push or a merge request creates no pipeline (`workflow: rules`).

What it does: one job, `pipeline`, on a Docker runner in privileged mode (gitlab.com's instance runners are). [gitlab.sh](gitlab.sh) starts a Docker daemon inside the job, a Node container on the job's network with the checkout mounted at its own path and its temporary files under it (`.tmp/`, so the tests' clones, which run Docker too, are at the same path for the daemon), installs, starts the development stack of `deploy/compose.yaml` on that daemon, its ports on the job's localhost as on a laptop, and creates the job's slice; then one script line per step runs `pnpm ci:local <step>` in that container, in the order of `steps.json`, which the test checks. Every command it runs in that container sets umask 022 first. A command `docker exec` starts gets the daemon's umask, 0000 in the job, and @swc/core, which `next.config` loads through next-intl, refuses a native cache under a folder other users can write. The job's image is the Docker image, the Node image comes as `NODE_IMAGE`, the stack's images are the ones `compose.yaml` pins and the scan's is the one `secrets-scan.ts` pins: every one by digest, and there is no include ([security §7](../../docs/rules/security.md#7-supply-chain-in-alpha)).

## Tests

`pnpm -F ci test` runs `tests/pipeline.test.ts`: the pipeline file and the folders a step's `only` names, which must define the step's script, then `pnpm ci:local` on a clone of the committed tree (every step, the cache, a lint fixture, a docs fixture); then `tests/supply-chain.test.ts`: on another clone, the settings, the build-script refusal, the hook, `secrets:scan` and `deps:check` with their fixtures. The first needs the laptop's stack up, for the deploy tests inside, and takes a few minutes; inside a `pnpm ci:local` run it checks the pipeline file only, since that run is the one under test. The second needs Docker and the registry, as the checks do, and takes about a minute. `pnpm -F ci typecheck` type-checks the package; Node 26 runs its files directly, with the Node types from `@types/node` at the root.
