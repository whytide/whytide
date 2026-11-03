# signals: the brief for a coding agent

1. Read `README.md`, then `docs/concepts.md`, `docs/data.md`, `docs/flows.md`, `docs/security.md` and `docs/runbook.md`. They say what is true now and change in the same merge request as the behavior.
2. The rules: [coding](../../../docs/rules/coding.md), [security](../../../docs/rules/security.md), [delivery](../../../docs/rules/delivery.md). The shape of this folder is [architecture §4.2](../../../docs/architecture.md#42-inside-a-module), plus `sources/`: one folder per kind and its contract (`_contract.ts`); the generated list `sources/registry.generated.ts` is never committed.
3. Commands, from the repository root: `pnpm -F @whytide/signals build`, `typecheck`, `test`, `test:tenancy`, `lint`; then `pnpm -F api test` for the routes, which the api loads from this module's `dist/`, `pnpm -F worker test` for the runs and schedules, and `pnpm -F web test` for the screen and the panel (README "Testing").
4. A new kind is a folder ("Adding a kind" in the README), never an edit to a list, a switch or an enum. The domain reads and writes through the request's tenant run (`tenantClient`), or the create's own (`addSource`), never a client of its own.
5. Stay inside this folder and `signals.prisma`; a change to a shared package is its own task.
