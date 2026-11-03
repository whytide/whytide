# approvals: the brief for a coding agent

1. Read `README.md`, then `docs/concepts.md`, `docs/data.md`, `docs/flows.md`, `docs/security.md` and `docs/runbook.md`. They say what is true now and change in the same merge request as the behavior.
2. The rules: [coding](../../../docs/rules/coding.md), [security](../../../docs/rules/security.md), [delivery](../../../docs/rules/delivery.md). The shape of this folder is [architecture §4.2](../../../docs/architecture.md#42-inside-a-module): rules in `domain/` without a framework, Zod schemas in `schemas/`, NestJS in `api/`, Temporal in `workflows/`, agent tasks in `agents/` (importing `@whytide/ai`, never `@mastra/*`), Next.js in `ui/`, every screen string a key in `messages/en.json`, the registries in `permissions.ts`, `prices.ts`, `events.ts` and `settings.ts`, the tests in `tests/`.
3. Commands, from the repository root: `pnpm -F approvals build`, `pnpm -F approvals typecheck`, `pnpm -F approvals test`, `pnpm -F approvals lint`.
4. Stay inside this folder and the module's schema file. A change to a shared package is its own task.
5. Nothing outside approvals decides an item: campaigns opens items and tells approvals about its holds and waits (`openItem`, `cancelItems`, `noteItemWait`); only the routes approve or skip, as the sender account's owner.
