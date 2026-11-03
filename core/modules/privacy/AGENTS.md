# privacy: the brief for a coding agent

1. Read `README.md`, then `docs/concepts.md`, `docs/data.md`, `docs/flows.md`, `docs/security.md` and `docs/runbook.md`. They say what is true now and change in the same merge request as the behavior.
2. The rules: [coding](../../../docs/rules/coding.md), [security](../../../docs/rules/security.md), [delivery](../../../docs/rules/delivery.md). The shape of this folder is [architecture §4.2](../../../docs/architecture.md#42-inside-a-module): rules in `domain/` without a framework, the command in `cli/`, the registries in `errors.ts` and `ids.ts`, the tests in `tests/`.
3. Commands, from the repository root: `pnpm -F privacy build`, `typecheck`, `test`, `test:tenancy`, `lint`; `pnpm erase …` runs the command (README.md "The deletion script").
4. A module that keeps a person's rows erases them itself: it exports `erasePerson(personId)`, returning the rows deleted by table, from its `index.ts`, and you register it in `domain/erase/erasers.ts` with the modules its rows name in `dependsOn`. Never delete another module's rows from here; the platform's tables are the one exception (README.md "Erasers").
5. Never add `@whytide/privacy` to a host's or a module's dependencies: privacy imports the modules, and pnpm refuses the cycle. Nothing the command prints or logs names the person: counts, codes and ids of the log only.
6. Stay inside this folder and `privacy.prisma`; a change to another module's eraser is that module's change, with its test.
