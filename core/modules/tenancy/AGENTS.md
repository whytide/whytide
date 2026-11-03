# tenancy: the brief for a coding agent

1. Read `README.md`, then `docs/concepts.md`, `docs/data.md`, `docs/flows.md`, `docs/security.md` and `docs/runbook.md`. They say what is true now and change in the same merge request as the behavior.
2. The rules: [coding](../../../docs/rules/coding.md), [security](../../../docs/rules/security.md), [delivery](../../../docs/rules/delivery.md). The shape of this folder is [architecture §4.2](../../../docs/architecture.md#42-inside-a-module): rules in `domain/` without a framework, Zod schemas in `schemas/`, NestJS in `api/`, every screen string a key in `messages/en.json`, the registries in `permissions.ts`, `prices.ts`, `events.ts` and `settings.ts`, the tests in `tests/`.
3. Commands, from the repository root: `pnpm -F @whytide/tenancy build`, `typecheck`, `test`, `test:tenancy`, `lint`; `pnpm -F @whytide/api test` for `GET /v1/me`.
4. Every table access goes through `domain/store.ts`, on its three paths; a new read across workspaces is a security change (`docs/security.md`). Query each model on its own: the tenant client refuses a relation in any argument.
5. Tests import `domain/` and `testing/`, never `index.ts` or `api/`: Node cannot run the controller's decorators from source. Stay inside this folder and `tenancy.prisma`; a change to a shared package is its own task.
