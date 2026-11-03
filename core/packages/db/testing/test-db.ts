// The database of a test file: one schema of the worktree's database per node:test worker (every
// test file is one), created and migrated before the first test, emptied before each test, dropped
// after the last (docs/rules/delivery.md §4: one migrated database per worktree, a schema per
// worker, truncation between tests, never a database recreate). The schema starts the way the roles
// migration leaves `public`: the statements of prisma/migrations/20261021000000_db_roles that name
// `SCHEMA public`, read from its text and replayed with the schema's name (USAGE for app and
// billing_writer, the owner's default privileges for app); then the real migrations plus the fixtures
// asked for run into it as the owner, so every grant a migration writes holds in the schema too. No
// other migration names `SCHEMA public`: it would hold in `public` and silently not here;
// tests/roles.test.ts checks that.

import { readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { after, before, beforeEach } from "node:test";
import type { PrismaClient } from "../generated/client.ts";
import { createDbClient } from "../src/client.ts";
import { type DbRole, databaseUrl } from "../src/env.ts";
import { runMigrations } from "../src/migrate.ts";
import { migrationsDir } from "../src/release-snapshot.ts";
import { sqlStatements } from "../src/sql-statements.ts";
import { migrationSet } from "./migrations.ts";

/** The roles migration, the first one: its statements on `public` start every test schema. */
export const ROLES_MIGRATION = "20261021000000_db_roles";
const PUBLIC_SCHEMA = /\bSCHEMA\s+public\b/i;

export type TestDbOptions = {
  /** Fixture migrations of tests/fixtures/migrations/ applied after the real ones. */
  readonly fixtures?: readonly string[];
};

export type TestDb = {
  /** The schema of this test file, `test_<package>_<file>`. */
  readonly schema: string;
  /** Empties every table of the schema; runs before each test by itself. */
  truncate(): Promise<void>;
};

let current: { readonly db: TestDb; readonly clients: Map<DbRole, PrismaClient> } | undefined;

/**
 * Called once at the top of a test file: registers the hooks that create, migrate, empty and drop
 * the file's schema around its tests. `asRole(role)` then gives a client inside it.
 */
export function withTestDb(options: TestDbOptions = {}): TestDb {
  if (current) throw new Error("withTestDb() is called once per test file");
  const schema = schemaName();
  const clients = new Map<DbRole, PrismaClient>();
  const owner = () => client(clients, schema, "owner");
  const db: TestDb = { schema, truncate: () => truncateSchema(owner(), schema) };
  current = { db, clients };
  let set: ReturnType<typeof migrationSet> | undefined;
  before(async () => {
    const o = owner();
    await o.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await o.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    for (const statement of schemaGrantStatements(schema)) await o.$executeRawUnsafe(statement);
    set = migrationSet(`test-db-${schema}`, options.fixtures);
    const url = new URL(databaseUrl("owner"));
    url.searchParams.set("schema", schema);
    await runMigrations({ url: url.toString(), config: set.config });
  });
  beforeEach(() => db.truncate());
  after(async () => {
    try {
      await owner().$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      for (const c of clients.values()) await c.$disconnect();
      if (set) rmSync(set.dir, { recursive: true, force: true });
      current = undefined;
    }
  });
  return db;
}

/** A client connected as `role`, working in the test file's schema; disconnected after the last test. */
export function asRole(role: DbRole): PrismaClient {
  if (!current) throw new Error("asRole() needs withTestDb() at the top of the test file");
  return client(current.clients, current.db.schema, role);
}

/**
 * The statements of the roles migration that name `SCHEMA public`, with `schema` in their place:
 * what a test schema starts with, so that it carries the grants `public` carries.
 */
export function schemaGrantStatements(schema: string): string[] {
  const sql = readFileSync(join(migrationsDir, ROLES_MIGRATION, "migration.sql"), "utf8");
  return sqlStatements(sql)
    .filter((statement) => PUBLIC_SCHEMA.test(statement.text))
    .map((statement) => statement.source.replace(/\bSCHEMA\s+public\b/gi, `SCHEMA "${schema}"`));
}

function client(clients: Map<DbRole, PrismaClient>, schema: string, role: DbRole): PrismaClient {
  let c = clients.get(role);
  if (!c) {
    c = createDbClient(role, { schema });
    clients.set(role, c);
  }
  return c;
}

/** `test_<package folder>_<test file>`: the same name on every run, so a crashed run leaves nothing new. */
function schemaName(): string {
  const file = basename(process.argv[1] ?? "", ".ts").replace(/\.test$/, "") || String(process.pid);
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  return `test_${slug(basename(process.cwd()))}_${slug(file)}`.slice(0, 63);
}

async function truncateSchema(owner: PrismaClient, schema: string): Promise<void> {
  const tables = await owner.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = ${schema} AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${schema}"."${t.tablename}"`).join(", ");
  await owner.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
