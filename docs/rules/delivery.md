# Delivery rules

| | |
|---|---|
| **Purpose** | How a task goes from a file in this folder to merged code: the worktree, the checks, the pull request, and what "done" means. Condensed from [architecture §19](../architecture.md#19-development-and-delivery) and, in the private planning repository, docs/16 §5, §6 and §8. |
| **Read with** | [coding](coding.md) · [security](security.md) |

## 1. Pick a task

- Priority runs from 0, the highest, to 10. Take the lowest-numbered folder, then the lowest-numbered task whose `Depends on` tasks are all `done`. Read the task file, the three rules files, the module's `README.md` and `AGENTS.md` if they exist, and the sources the task links. Nothing else should be needed; if it is, the task is incomplete: say so in its Open questions.
- Set the task's `Status` to `in progress`. The task files live in the private docs repository (`whytide-docs`), committed straight to its `main`; the code lives in the public code repository (`whytide`).
- If the task is wrong, too big or blocked: stop, write what you found in the task's Open questions and in the pull request, and split rather than grow. Never add scope to a task.

## 2. One task, one worktree

- One task, one git worktree, one branch, one module. Branch: `task/<ID>-<slug>`, for example `task/alpha-p3-020-credits-tables`.
- **One shared stack per laptop, one slice of it per worktree.** Postgres, Redis, Temporal, MinIO, Mailpit and the observability container start once, from the development Compose file, and every worktree uses those same instances. `pnpm env:create` starts nothing: it creates a database `app_<worktree>` in the running Postgres server, a namespace in the running Temporal, a key prefix in the running Redis, a bucket in the running MinIO, picks free ports for the worktree's own api, web and worker processes, and writes all of it to `.env.local`. `pnpm env:destroy` drops them. Never a second Postgres, Temporal, Redis or MinIO per task; never two worktrees on one database.
- Migrations in a worktree apply to its database only. Every worktree's outgoing mail lands in the one Mailpit inbox, where the sign-in link is read during development and by the Compose smoke test.
- Secrets stay out of worktrees: a development LLM key with a small cap comes through the environment; the fake adapters cover everything else.

## 3. While working

- Start from the acceptance criteria: the task's end-to-end test proves them from the outside, and a unit test covers only the business logic that deserves isolation ([coding §11](coding.md#11-tests)). Write the test before the code that satisfies it where you can; what cannot be tested is a recorded manual check in the pull request.
- **Run the task's own tests, never the whole app's:** the task's end-to-end spec by name, the module's tests with `pnpm -F <module> test`, lint and typecheck on the module. Watch mode while coding, one full run of those before the pull request.
- Keep `domain/` pure, the fake adapters in the tests, the strings in the message file, the docs in the module. The lint rules say when you forget; do not silence them.
- Commit small and often. Subject in the imperative, under 70 characters; the task ID in the body. The squash merge removes the branch's history, so a rough commit on the branch is fine.

## 4. Before the pull request

What every task runs locally:

- its end-to-end test and the tests of the module or package it changed;
- lint and typecheck of that module or package;
- the message-key check when a screen changed; the migration on the worktree's database when a table changed;
- the task's `.http` file under [`api-calls/`](../../api-calls/README.md) written when an endpoint was added, or the file that holds the endpoint updated when it changed; each new request run once against the worktree's api.

Nothing runs in GitLab CI by itself: pipeline minutes are scarce, so the pipeline is triggered by hand, never by a push or a pull request. The same steps run on a laptop with one command, `pnpm ci:local`, and that is the gate. **The full pipeline runs twice per priority folder:** before the first task's pull request, to prove the folder's foundation, and before the last task's, to prove the folder as a whole; the index marks those two tasks. Each of those two runs is local, `pnpm ci:local`, and then in GitLab, triggered by hand on the pushed branch. No other task triggers the GitLab pipeline, whatever it changes.

The full pipeline, the same steps locally (`pnpm ci:local`) and in GitLab when triggered:

| Check | Proves |
|---|---|
| Lint: module boundaries, no vendor SDK outside its adapter, no string literal in a screen | The structure holds |
| Typecheck; the module's tests: end to end for every task, unit on business logic | The task does what it says |
| Contract tests on every adapter; the suite on the fakes | Nothing outside the adapter depends on the vendor |
| Tenancy: `workspace_id` on every tenant table; two-workspace isolation | No leak |
| Roles: `app` cannot write a grant | The credit tables are bounded |
| Migrations on a fresh database and on the previous release | Upgrades work |
| OpenAPI generated; the web client built from it | The schemas are sound |
| Message keys exist, none unused, ICU valid; the docs-touch check | Text and docs are kept up |
| Workflow replay tests; the Compose smoke test: up, migrate, health, sign-in | The system starts |
| Secret scanning, dependency review, the license check; a changeset present | The supply chain holds |

Also: the migration is named `<module>_<change>`; the `.env.example` block is updated; no generated file is committed; the module docs changed with the behavior, or the pull request carries `docs-not-needed` and the reviewer agrees.

**Keeping tests fast**, so "done" takes minutes, not an hour:

- Fake adapters only: no network, no vendor, no secret, no sleep.
- One migrated database per worktree, reused across runs. Tests clean up by truncation or a rolled-back transaction, never by recreating the database; a parallel worker gets its own schema.
- Workflows run under Temporal's test environment with time skipping; the real Temporal is for the Compose smoke test only.
- Playwright runs Chromium only, headless, against the worktree's already running web and api (reuse the server); the browser matrix runs only in the full pipeline. One flow per test, asserting the acceptance criteria; screenshots and videos on failure only.
- Sign in and seed data through test helpers and factories, not through the screens, except in the task that builds sign-in.
- Tests are independent, so they run in parallel workers and can be selected by file or name.
- The OpenAPI document and the generated client are rebuilt only when a schema changed; typecheck is incremental, with project references.
- The pipeline, local or in GitLab, caches the package store and the build outputs, so an unchanged package is not rebuilt or retested.

## 5. The pull request

- On GitLab a pull request is a merge request; the rules are the same.
- One module or package, under about 700 changed lines. Split otherwise.
- The template's questions, answered: which module; which task and briefs; migration yes or no; new provider yes or no; new permission, price, event, setting or message keys yes or no; docs updated or `docs-not-needed`; changeset present; made by a coding agent yes or no (the `ai-generated` label).
- Call out, in the description, every new dependency, network call, permission, table with personal data, or way for data to leave the system ([security §8](security.md#8-conduct)).
- One review by a module owner; two on the security-sensitive paths. Squash merge, linear history, no force-push to `main`.
- Never edit the pipeline definition, `CODEOWNERS`, a security-sensitive path or a generated file to make a check pass. Review treats that as a defect.
- Branches live days, not weeks. Unfinished work ships behind a flag.

## 6. Done

A task is done when:

1. Every acceptance criterion is proven by its end-to-end test, by a unit test where there is business logic, or by a manual check recorded in the pull request.
2. The task's own tests are green locally and no check was weakened. The first and the last task of a folder also ran the full pipeline, locally and in GitLab; no other task triggered the GitLab pipeline.
3. The module's docs, README and `AGENTS.md` say what is now true.
4. The pull request is merged.
5. The task file's `Status` is `done` in the docs repository, set by whoever merges the pull request.

## 7. Alpha speed mode

Until the alpha ships, by the owner's decision of 2026-10-22, a task finishes fast so that the tasks after it can start. What it cuts is written down, in the planning repository's `implementation/tasks/alpha/revisit.md`, and done before the alpha ships.

Where this section differs from any of the following, this section wins:
- §1 to §6;
- [architecture §19](../architecture.md#19-development-and-delivery);
- [tools/ci/README.md](../../tools/ci/README.md);
- two lines of the security rules: one dependency per pull request ([§7](security.md#7-supply-chain-in-alpha)) and two reviews ([§8](security.md#8-conduct)), whose security review comes later.

Every other security rule holds.

- **Size:** a pull request stays under about 1,500 changed lines, lock files and generated files aside.
- **Checks:** the task's own tests, lint and typecheck (§3, §4), plus, where they apply:
  - `test:tenancy` and `test:roles` when a table changed;
  - `test:contract` for an adapter;
  - `messages:check` for a screen;
  - `deps:check` for a dependency pull request.

  The rest of the full pipeline gates no pull request: no task runs the full `pnpm ci:local` or triggers the GitLab pipeline, the first and the last of a folder included. It runs once per folder on `main` before the alpha ships.
- **Tests:** one per acceptance criterion, plus those the security rules and [coding §11](coding.md#11-tests) require:
  - two-workspace isolation for a tenant table;
  - the contract suite for an adapter;
  - anonymization for an AI call.

  No mutation runs, probes or extra edge-case suites.
- **Review:** one quick review per pull request, for blockers only:
  - an unmet criterion;
  - a break for the tasks that build on it;
  - a security rule broken in the code;
  - a weakened check.

  The merger checks the fixes; they are not reviewed again. Every other finding is one line in the deferred list. The in-depth review and the security review come later.
- **Dependencies:** one dependency pull request per task, holding all of its new packages, each with its reason and license ([coding §10](coding.md#10-style)).
  - It carries the labels `dependency` and `dependency-update`; the second lifts `deps:check`'s one-package limit.
  - Before it merges, it runs `pnpm ci:local deps:check --labels dependency,dependency-update`: the audit and the license check.
- **API calls:** a task that adds an endpoint writes its file `api-calls/<task ID>-<slug>.http`, one request per endpoint; a task that changes an endpoint updates the request in the file that holds it ([api-calls/README.md](../../api-calls/README.md)). It writes them and does not run them.
- **Description:** short: the template's answers, each criterion with its proof, the call-outs, the choices made, the open questions, and what is deferred.
- **Done:** a task is done when its pull request merges and what it deferred is listed. The tasks that depend on it start then.

What does not change:
- the [security rules](security.md) in the code;
- one module per pull request;
- no weakened check;
- no secret or generated file committed;
- the docs with the code.
