# linkedin: the brief for a coding agent

1. Read `README.md`, then `docs/concepts.md`, `docs/data.md`, `docs/flows.md`, `docs/security.md` and `docs/runbook.md`. They say what is true now and change in the same merge request as the behavior.
2. The rules: [coding](../../../docs/rules/coding.md), [security](../../../docs/rules/security.md), [delivery](../../../docs/rules/delivery.md). The shape of this folder is [architecture §4.2](../../../docs/architecture.md#42-inside-a-module); the screen follows [core/apps/web/docs/screens.md](../../apps/web/docs/screens.md): `.tsx` files only under `ui/`, the API client from `@whytide/web/api/*`, which this package does not list.
3. Commands, from the repository root: `pnpm -F @whytide/linkedin build`, `typecheck`, `test`, `test:tenancy`, `lint`; then `pnpm -F api test` for the routes and the webhook, `pnpm -F worker test` and `test:replay` for the workflows and the subscriber, and `pnpm -F web test` for the screen, which load this module's `dist/`.
4. The reference is opened in `workflows/` only (`withDecryptedRef`), never in `api/`, `domain/` or the index: the lint's `decrypt-in-worker-only` refuses it. Never log, return or publish it, sealed or not.
5. No provider call inside a run: connect opens its own runs around it (`whytide:own-runs`), the webhook opens one only once the account is found.
6. Stay inside this folder and `linkedin.prisma`; a change to a shared package or a host is its own task, or called out as a host change.
7. No read of LinkedIn without a reservation: `reserveReads`, the read, then `commitReads` or `releaseReads`, and `logAction` for the read (README.md "Read quota"); the clock is `domain/clock.ts`, never `new Date()` in the quota.
