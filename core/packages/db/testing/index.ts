// The test helpers of @whytide/db, imported as `@whytide/db/testing` by every test that needs the
// database and never by production code (README "Register a tenant table in the isolation test"):
// a schema of the worktree's database per test file, a client per role in it, the two-workspace
// isolation harness, migration sets with fixtures and a scratch database for the migration tests, and
// the tenant tables that have a column (README "Tables by column").
export { checkIsolation, type IsolationSpec, isolationTest } from "./isolation.ts";
export {
  fixtureMigrationsDir,
  type MigrationSet,
  migrationSet,
  type ScratchDatabase,
  scratchDatabase,
} from "./migrations.ts";
export { type OwnedTable, tenantTablesWithColumn } from "./schema-tables.ts";
export { sqlstate } from "./sql.ts";
export { assertScoped } from "./tenant.ts";
export {
  asRole,
  ROLES_MIGRATION,
  schemaGrantStatements,
  type TestDb,
  type TestDbOptions,
  withTestDb,
} from "./test-db.ts";
