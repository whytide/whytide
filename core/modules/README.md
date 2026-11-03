# core/modules/

One folder per feature, every one with the same shape (docs/architecture.md §4.2, docs/rules/coding.md §4): `README.md`, `AGENTS.md`, `index.ts`, `domain/`, `schemas/`, `api/`, `workflows/`, `agents/`, `ui/`, `messages/`, `docs/`, `tests/` and the four registry files `permissions.ts`, `prices.ts`, `events.ts` and `settings.ts`.

`pnpm module:new <name>` copies `_template/` to `<name>/`; then `pnpm install` registers the package. A module imports another only as `@whytide/<name>`, its `index.ts`, and depends on `platform`, `providers`, `ai` and `db`, never on a host (docs/rules/coding.md §2); `pnpm lint` enforces it. Alpha's modules, in order: tenancy, identity, onboarding, icp, signals, qualification, discovery, contacts, messaging, linkedin, credits.

Beta's modules, as they join: approvals, campaigns, inbox.
