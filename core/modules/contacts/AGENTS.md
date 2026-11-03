# contacts: the brief for a coding agent

1. Read `README.md`, then `docs/concepts.md`, `docs/data.md`, `docs/flows.md`, `docs/security.md` and `docs/runbook.md`. They say what is true now and change in the same merge request as the behavior.
2. The rules: [coding](../../../docs/rules/coding.md), [security](../../../docs/rules/security.md), [delivery](../../../docs/rules/delivery.md). The shape of this folder is [architecture §4.2](../../../docs/architecture.md#42-inside-a-module): rules in `domain/` without a framework, Zod schemas in `schemas/`, NestJS in `api/`, every screen string a key in `messages/en.json`, the registries in `permissions.ts`, `prices.ts`, `events.ts` and `settings.ts`, the tests in `tests/`.
3. Commands, from the repository root: `pnpm -F @whytide/contacts build`, `typecheck`, `test`, `test:tenancy`, `lint`; `pnpm -F @whytide/api test` for the routes; `pnpm -F web test` for the screens, whose specs are the web host's (`core/apps/web/tests/lead-*.spec.ts`, `contacts-*.spec.ts`, README "Testing").
4. Every command runs in the caller's tenant run through `tenantClient` and opens none. Query each model on its own: the tenant client refuses a relation in any argument.
5. A new column gets its class in `domain/fields.ts`, a `/// pii: <class>` line in `contacts.prisma` unless it is `none`, and then its key in the platform's `piiKeys`; `tests/schema.test.ts` fails otherwise. Never a column for contact details, a photo or a special category.
6. Tests import `domain/` and `testing/`, never `index.ts` or `api/`: Node cannot run the controller's decorators from source. They set the salt with `useHashSalt`, never a real one.
7. A screen's every state, empty, loading and error, takes its text from a key and has a spec.
8. A chunk of persons or leads goes through the batched commands, whose test holds them equal to the one-row ones (`tests/batch.test.ts`).
