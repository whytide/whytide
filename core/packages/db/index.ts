// The public interface of @whytide/db (docs/architecture.md §4.1): a client per role, the migration
// runner the api host calls before it listens, and the generated client's types. The schema files,
// the migrations and the lint live beside it (README.md).
export { Prisma, type PrismaClient } from "./generated/client.ts";
export { type CreateDbClientOptions, createDbClient } from "./src/client.ts";
export { costStore } from "./src/cost-store.ts";
export { type DbRole, databaseUrl } from "./src/env.ts";
export { idempotencyStore } from "./src/idempotency-store.ts";
export { type RunMigrationsOptions, runMigrations } from "./src/migrate.ts";
export { createOutboxStore, type OutboxStoreOptions, outboxWriter } from "./src/outbox.ts";
export {
  disconnectTenantClient,
  globalClient,
  type TenantClient,
  tenantClient,
  type WithTenantOptions,
  withTenant,
} from "./src/tenant.ts";
