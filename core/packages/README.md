# core/packages/

What every module uses, changed in its own merge request before the modules that need it (docs/rules/coding.md §1 and §2): `platform` (the principal and permissions, the credits client, events, config, ids, the i18n runtime, the egress client), `db` (Prisma: one schema file per module, migrations, roles), `providers` (the ports and their adapters), `ai` (the Mastra setup, the task registry, the eval runner) and `ui` (shared components, tokens, shared messages). `platform`, `db` and the adapters take two reviews (docs/rules/security.md §8).
