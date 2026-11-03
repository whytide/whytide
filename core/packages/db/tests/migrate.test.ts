// The end-to-end test of alpha-p1-010 (docs/rules/coding.md §11): the runner and the roles, used the
// way the api host and later tasks use them, on a scratch database `<slice database>_migrate_test`
// next to the worktree's slice database (testing/migrations.ts): created from zero and dropped at the
// end, so the slice's own database is never recreated and the other test files, each in a schema of
// it, run at the same time. runMigrations() applies, from a temporary migrations folder, the real
// migrations plus a fixture tenant table; a second run is a no-op; three connections prove what `app`
// and `billing_writer` can and cannot do; a failing migration throws and keeps throwing; then the
// real migrations alone apply from zero. The name checks and the ignore rules close the file. Run
// with `pnpm -F db test`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { isAppError } from "@whytide/platform";
import { createDbClient, runMigrations } from "../index.ts";
import { databaseUrl } from "../src/env.ts";
import { checkMigrationFolders, migrationNameProblem } from "../src/migration-names.ts";
import { packageRoot, repositoryRoot } from "../src/paths.ts";
import { recreateDatabase } from "../src/reset.ts";
import { scratchDatabase, sqlstate, migrationSet as temporarySet } from "../testing/index.ts";

const ROLES = "20261021000000_db_roles";
const FIXTURE = "20261021000100_db_test_tenant_fixture";
const BROKEN = "20261021000200_db_test_broken";
const TABLE = "db_test_tenant_fixture";
/** Every folder of prisma/migrations, in the order Prisma applies them. */
const REAL = readdirSync(join(packageRoot, "prisma", "migrations"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
/** The real migrations plus the fixture tenant table, in the order applied. */
const WITH_FIXTURE = [...REAL, FIXTURE].sort();

type Row = { migration_name: string; finished_at: Date | null };

const sliceUrl = databaseUrl("owner");
const database = new URL(sliceUrl).pathname;
for (const role of ["app", "billing_writer"] as const) {
  assert.equal(new URL(databaseUrl(role)).pathname, database, `${role} points at another database`);
}

/** The database the runner works on from zero; the slice's own is never recreated by a test. */
const scratch = scratchDatabase("migrate_test");
const ownerUrl = scratch.url("owner");

mkdirSync(join(packageRoot, ".tmp"), { recursive: true });
const sets: string[] = [];

/** A prisma.config.ts whose migrations folder holds the real migrations plus the fixtures named. */
function migrationSet(name: string, fixtures: readonly string[]): string {
  const set = temporarySet(name, fixtures);
  sets.push(set.dir);
  return set.config;
}

async function appliedRows(): Promise<Row[]> {
  const owner = createDbClient("owner", { url: ownerUrl });
  try {
    return await owner.$queryRawUnsafe<Row[]>(
      "SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at",
    );
  } finally {
    await owner.$disconnect();
  }
}

test("the runner and the roles on a scratch database", async (t) => {
  try {
    await t.test(
      "a fresh database takes the roles migration and a later one, in order",
      async () => {
        assert.equal(await recreateDatabase(ownerUrl), scratch.name);
        const applied = await runMigrations({
          url: ownerUrl,
          config: migrationSet("with-fixture", [FIXTURE]),
        });
        assert.equal(REAL[0], ROLES, "the roles migration comes first");
        assert.deepEqual(applied, WITH_FIXTURE);
        const rows = await appliedRows();
        assert.deepEqual(
          rows.map((row) => row.migration_name),
          WITH_FIXTURE,
        );
        assert.ok(
          rows.every((row) => row.finished_at !== null),
          "every applied migration is finished",
        );
      },
    );

    await t.test("a second run is a no-op", async () => {
      const applied = await runMigrations({
        url: ownerUrl,
        config: migrationSet("with-fixture", [FIXTURE]),
      });
      assert.deepEqual(applied, []);
      assert.equal((await appliedRows()).length, WITH_FIXTURE.length);
    });

    await t.test("app reads and writes the fixture tenant table and cannot run DDL", async () => {
      const app = createDbClient("app", { url: scratch.url("app") });
      try {
        assert.equal(
          await app.$executeRawUnsafe(
            `INSERT INTO "${TABLE}" ("id", "workspace_id", "note") VALUES ('row_1', 'wsp_1', 'first')`,
          ),
          1,
        );
        assert.equal(
          await app.$executeRawUnsafe(
            `UPDATE "${TABLE}" SET "note" = 'second' WHERE "id" = 'row_1'`,
          ),
          1,
        );
        const rows = await app.$queryRawUnsafe<{ note: string }[]>(
          `SELECT "note" FROM "${TABLE}" WHERE "workspace_id" = 'wsp_1'`,
        );
        assert.deepEqual(rows, [{ note: "second" }]);
        assert.equal(await app.$executeRawUnsafe(`DELETE FROM "${TABLE}" WHERE "id" = 'row_1'`), 1);
        assert.equal(
          await sqlstate(
            app.$executeRawUnsafe('CREATE TABLE "db_test_by_app" ("id" TEXT NOT NULL)'),
          ),
          "42501",
          "app must not create a table",
        );
        assert.equal(
          await sqlstate(app.$executeRawUnsafe(`ALTER TABLE "${TABLE}" ADD COLUMN "extra" TEXT`)),
          "42501",
          "app must not alter a table",
        );
        assert.equal(
          await sqlstate(app.$executeRawUnsafe(`DROP TABLE "${TABLE}"`)),
          "42501",
          "app must not drop a table",
        );
        assert.equal(
          await sqlstate(app.$queryRawUnsafe("SELECT count(*) FROM _prisma_migrations")),
          "42501",
          "app must not read the migrations table",
        );
      } finally {
        await app.$disconnect();
      }
    });

    await t.test("billing_writer cannot read or write the fixture tenant table", async () => {
      const billing = createDbClient("billing_writer", { url: scratch.url("billing_writer") });
      try {
        assert.equal(
          await sqlstate(billing.$queryRawUnsafe(`SELECT "id" FROM "${TABLE}"`)),
          "42501",
          "billing_writer must not read a tenant table",
        );
        assert.equal(
          await sqlstate(
            billing.$executeRawUnsafe(
              `INSERT INTO "${TABLE}" ("id", "workspace_id", "note") VALUES ('row_2', 'wsp_1', 'x')`,
            ),
          ),
          "42501",
          "billing_writer must not write a tenant table",
        );
        const who = await billing.$queryRawUnsafe<{ user: string }[]>(
          "SELECT current_user AS user",
        );
        assert.match(who[0]?.user ?? "", /billing_writer/, "connected as a billing_writer role");
      } finally {
        await billing.$disconnect();
      }
    });

    await t.test("a pending migration that fails makes runMigrations() throw, twice", async () => {
      const config = migrationSet("with-broken", [FIXTURE, BROKEN]);
      await assert.rejects(runMigrations({ url: ownerUrl, config }), (error: Error) => {
        assert.match(error.message, new RegExp(BROKEN), "the error names the migration");
        assert.match(
          error.message,
          /db_test_no_such_table/,
          "the error carries the database's reason",
        );
        return true;
      });
      const rows = await appliedRows();
      assert.equal(rows.at(-1)?.migration_name, BROKEN);
      assert.equal(
        rows.at(-1)?.finished_at,
        null,
        "the failed migration is recorded as unfinished",
      );
      await assert.rejects(runMigrations({ url: ownerUrl, config }), /P3009|failed migration/i);
    });

    await t.test("the real migrations alone, from zero", async () => {
      await recreateDatabase(ownerUrl);
      assert.deepEqual(await runMigrations({ url: ownerUrl }), REAL);
      assert.deepEqual(await runMigrations({ url: ownerUrl }), []);
    });
  } finally {
    await scratch.drop();
    for (const dir of sets) rmSync(dir, { recursive: true, force: true });
  }
});

test("migration names: the folder check and the migrate:dev refusal", () => {
  assert.deepEqual(checkMigrationFolders(join(packageRoot, "prisma", "migrations")), []);
  assert.deepEqual(checkMigrationFolders(join(packageRoot, "tests", "fixtures", "migrations")), []);
  const bad = mkdtempSync(join(packageRoot, ".tmp", "names-"));
  try {
    for (const folder of [
      "20261021000000_db_roles",
      "0001_db_roles",
      "20261021000000_roles",
      "20261021000000_db_Roles",
      "20261021000000_db-roles",
    ]) {
      mkdirSync(join(bad, folder));
    }
    writeFileSync(join(bad, "migration_lock.toml"), 'provider = "postgresql"\n');
    const problems = checkMigrationFolders(bad);
    assert.deepEqual(problems.map((p) => p.slice(bad.length + 1).split(":")[0]).sort(), [
      "0001_db_roles",
      "20261021000000_db-roles",
      "20261021000000_db_Roles",
      "20261021000000_roles",
    ]);
    assert.equal(readdirSync(bad).length, 6);
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
  assert.equal(migrationNameProblem("credits_tables"), undefined);
  assert.equal(migrationNameProblem("db_roles"), undefined);
  for (const name of [
    "roles",
    "db_Roles",
    "db-roles",
    "Db_roles",
    "db_",
    "_roles",
    "20261021_db_x",
  ]) {
    assert.match(migrationNameProblem(name) ?? "", /<module>_<change>/, name);
  }
  const refused = spawnSync(
    process.execPath,
    [join(packageRoot, "src", "cli.ts"), "migrate-dev", "--name", "AddPersons"],
    { encoding: "utf8", env: { ...process.env, DATABASE_URL_OWNER: sliceUrl } },
  );
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /<module>_<change>/);
  assert.doesNotMatch(refused.stdout + refused.stderr, /Prisma schema loaded/, "prisma never ran");
});

test("no generated client, openapi.json or .env.local is tracked", () => {
  const tracked = spawnSync(
    "git",
    [
      "ls-files",
      "--",
      "core/packages/db/generated",
      ".env.local",
      "*openapi.json",
      "*.generated.*",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(tracked.status, 0, tracked.stderr);
  assert.equal(tracked.stdout.trim(), "");
});

test("databaseUrl names the variable and pnpm env:create when a slice is missing, never a value", () => {
  assert.throws(
    () => databaseUrl("owner", {}),
    /DATABASE_URL_OWNER is not set: run pnpm env:create/,
  );
  const worker = { DATABASE_URL: "postgresql://app:whytide@127.0.0.1:5432/app" };
  assert.equal(databaseUrl("app", worker), worker.DATABASE_URL, "a process holds only its strings");
  assert.throws(() => databaseUrl("owner", worker), /DATABASE_URL_OWNER is not set/);
  assert.throws(
    () => databaseUrl("app", { DATABASE_URL: "mysql://app:top-secret@127.0.0.1:3306/app" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^DATABASE_URL: .*deploy\/\.env\.example/);
      assert.doesNotMatch(error.message, /top-secret/);
      assert.ok(
        isAppError(error.cause) && error.cause.code === "config_invalid",
        "the platform's code",
      );
      assert.doesNotMatch(JSON.stringify(error.cause.details), /top-secret/);
      return true;
    },
  );
});
