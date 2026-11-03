// The public interface of credits (README.md): its routes, the balance a workspace sees, the period
// rule, the start hook the api host awaits before it listens (the client's binding, the seeder and the
// prices) and the registries the hosts load, with the subscription to tenancy's organization_created.
// Modules reserve through the platform's `credits` client, never here. Nothing else in this module is
// importable from outside it (docs/rules/coding.md §2).
export { CreditsApi as api } from "./api/credits.controller.ts";
export { type Balance, readBalance } from "./domain/balance.ts";
export { type Period, periodFor } from "./domain/period.ts";
export { onStart } from "./domain/seed.ts";
export { errors } from "./errors.ts";
export { events } from "./events.ts";
export { ids } from "./ids.ts";
export { permissions } from "./permissions.ts";
export { settings } from "./settings.ts";
