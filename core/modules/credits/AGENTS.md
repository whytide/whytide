# credits: the brief for a coding agent

1. Read `README.md`, then `docs/concepts.md`, `docs/data.md`, `docs/flows.md`, `docs/security.md` and `docs/runbook.md`. They say what is true now and change in the same merge request as the behavior.
2. The rules: [coding](../../../docs/rules/coding.md), [security](../../../docs/rules/security.md), [delivery](../../../docs/rules/delivery.md). The shape of this folder is [architecture §4.2](../../../docs/architecture.md#42-inside-a-module): rules in `domain/` without a framework, Zod schemas in `schemas/`, NestJS in `api/`, Temporal in `workflows/`, the registries in `permissions.ts`, `prices.ts`, `events.ts` and `settings.ts`, the tests in `tests/`.
3. Commands, from the repository root: `pnpm -F credits build`, `typecheck`, `test`, `test:tenancy`, `lint`; `pnpm -F db test:roles` for the grants; `pnpm credits:seed` runs the seeder.
4. The grants, the triggers and `credits_seed_self_hosted` are SQL in the migrations `credits_initial` and `credits_reserve`: a change to them is a new migration and a security change (`docs/security.md`). Never write `credit_balances`: the triggers do. Read the organization-level tables through `domain/store.ts`, for the organization tenancy gives.
5. Stay inside this folder and `credits.prisma`; a change to a shared package is its own task.
