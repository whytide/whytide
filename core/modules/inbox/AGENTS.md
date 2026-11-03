# inbox: the brief for a coding agent

1. Read `README.md`, then `docs/concepts.md`, `docs/data.md`, `docs/flows.md`, `docs/security.md` and `docs/runbook.md`. They say what is true now and change in the same merge request as the behavior.
2. The rules: [coding](../../../docs/rules/coding.md), [security](../../../docs/rules/security.md), [delivery](../../../docs/rules/delivery.md). The shape of this folder is [architecture §4.2](../../../docs/architecture.md#42-inside-a-module): rules in `domain/` without a framework, Zod schemas in `schemas/`, NestJS in `api/`, Temporal in `workflows/`, agent tasks in `agents/` (importing `@whytide/ai`, never `@mastra/*`), Next.js in `ui/`, every screen string a key in `messages/en.json`, the registries in `permissions.ts`, `prices.ts`, `events.ts` and `settings.ts`, the tests in `tests/`.
3. Commands, from the repository root: `pnpm -F inbox build`, `pnpm -F inbox typecheck`, `pnpm -F inbox test`, `pnpm -F inbox test:safety`, `pnpm -F inbox lint`.
4. Stay inside this folder and the module's schema file. A change to a shared package is its own task.
5. No model in the stop path: the module never depends on `@whytide/ai`, and the phrase list decides an opt-out. A message's text lives in its file until the store, then in `messages.body` only: never in an event, a workflow input, an activity's answer or a log line.
6. The reply mail (`domain/mail.ts`) carries the person's first name and the thread's link only: never the reply's text, another name, the company or the account's label, and never sent from a subscriber or inside a run.
7. Provider refs come from linkedin's `sentMessageRef`, never from campaigns: none crosses an event, a workflow input or an activity's answer (`domain/store/sent.ts`).
