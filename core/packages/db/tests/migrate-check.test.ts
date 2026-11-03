// The end-to-end test of `db:migrate:check` (alpha-p1-020; docs/rules/delivery.md §4,
// docs/architecture.md §7.6): on the current tree the check passes (expand first, a fresh scratch
// database, the previous release at the merge base migrated forward) and leaves no database behind;
// a release snapshot written from a fixture set restores and takes the new migrations; a release
// whose migration was edited after it shipped cannot be migrated forward; a pre-release tag and a
// stray file among the snapshots are refused; a bare DROP COLUMN fails the check before any database
// is touched. The scratch database is `<slice>_migrate_check_test`, the working folder `.tmp/` of it.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createDbClient } from "../index.ts";
import { migrateCheck } from "../src/migrate-check.ts";
import { temporaryFolder } from "../src/migration-set.ts";
import { packageRoot } from "../src/paths.ts";
import {
  latestReleaseSnapshot,
  migrationFolders,
  migrationsDir,
  unpackReleaseSnapshot,
  writeReleaseSnapshot,
} from "../src/release-snapshot.ts";
import { migrationSet, scratchDatabase } from "../testing/index.ts";

const RELEASE_TABLE = "20261021000400_db_test_release_table";
const ADD_NOTE = "20261021000500_db_test_release_add_note";
const BARE_DROP = "20261021000600_db_test_bare_drop";
const CONTRACT_DROP = "20261021000700_db_test_contract_drop";
/** Every real migration, in the order Prisma applies them; a fixture sorts in by its timestamp too. */
const REAL = migrationFolders(migrationsDir);
const scratch = "migrate_check_test";

test("the check on the current tree passes and leaves no database behind", async () => {
  const folder = join(packageRoot, ".tmp", scratch);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "stale.sql"), "-- left behind by a run that died\n");
  const lines: string[] = [];
  const report = await migrateCheck({ scratch, log: (line) => lines.push(line) });
  assert.equal(existsSync(folder), false, "the working folder, stale content included, is gone");
  assert.deepEqual(report.fresh, REAL, "every real migration applied from zero");
  assert.deepEqual(
    [...report.previous.restored, ...report.previous.applied].sort(),
    REAL,
    "the previous release's migrations plus the new ones are the tree's",
  );
  assert.match(report.previous.source, /^the (snapshot|migrations at [0-9a-f]{7})/);
  assert.match(
    lines.join("\n"),
    /expand-first: ok[\s\S]*fresh database: ok[\s\S]*previous release: ok/,
  );
  const owner = createDbClient("owner");
  try {
    const left = await owner.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_database WHERE datname = ${scratchDatabase(scratch).name}`;
    assert.equal(left[0]?.n, 0, "the scratch database is dropped");
  } finally {
    await owner.$disconnect();
  }
});

test("a release snapshot restores and migrates forward; an edited release does not", async () => {
  const tmp = temporaryFolder("migrate-check-test");
  const release = migrationSet("release", [RELEASE_TABLE, ADD_NOTE]);
  const current = migrationSet("current", [RELEASE_TABLE, ADD_NOTE, CONTRACT_DROP]);
  const edited = migrationSet("edited");
  const sets = [tmp, release.dir, current.dir, edited.dir];
  try {
    assert.throws(() => writeReleaseSnapshot("1.0", { releases: tmp }), /not a release tag/);
    assert.throws(
      () => writeReleaseSnapshot("v0.0.1-rc.1", { releases: tmp }),
      /"v0\.0\.1-rc\.1" is not a release tag, like v0\.1\.0$/,
      "a pre-release tag does not order, so it is not a snapshot",
    );
    const releases = join(tmp, "releases");
    assert.equal(latestReleaseSnapshot(releases), undefined, "no snapshot before the first tag");
    const snapshot = writeReleaseSnapshot("v0.0.10", { migrations: release.migrations, releases });
    writeReleaseSnapshot("v0.0.9", { migrations: release.migrations, releases });
    assert.equal(snapshot, join(releases, "v0.0.10.sql"));
    assert.equal(
      latestReleaseSnapshot(releases),
      snapshot,
      "the newest tag by version, not by name",
    );
    writeFileSync(join(releases, "notes.sql"), "-- not a snapshot\n");
    assert.throws(() => latestReleaseSnapshot(releases), /notes\.sql is not a release snapshot/);
    rmSync(join(releases, "notes.sql"));
    assert.deepEqual(
      unpackReleaseSnapshot(snapshot, join(tmp, "unpacked")),
      [...REAL, RELEASE_TABLE, ADD_NOTE].sort(),
    );

    const report = await migrateCheck({
      migrations: current.migrations,
      previous: snapshot,
      scratch,
    });
    assert.deepEqual(report.fresh, [...REAL, RELEASE_TABLE, ADD_NOTE, CONTRACT_DROP].sort());
    assert.deepEqual(report.previous.restored, [...REAL, RELEASE_TABLE, ADD_NOTE].sort());
    assert.deepEqual(report.previous.applied, [CONTRACT_DROP], "the marked drop applies forward");
    assert.equal(report.previous.source, "the snapshot v0.0.10.sql");

    // The release shipped the table with "note" already; the tree's version of that migration was
    // edited since and a later migration adds the column: the fresh run is fine, the upgrade is not.
    cpSync(
      join(packageRoot, "tests", "fixtures", "releases", "edited", RELEASE_TABLE),
      join(edited.migrations, RELEASE_TABLE),
      { recursive: true },
    );
    const forward = migrationSet("forward", [RELEASE_TABLE, ADD_NOTE]);
    sets.push(forward.dir);
    await assert.rejects(
      migrateCheck({ migrations: forward.migrations, previous: edited.migrations, scratch }),
      (error: Error) => {
        assert.match(error.message, /^previous release \(the folder .*\), migrating forward: /);
        assert.match(error.message, new RegExp(ADD_NOTE), "the error names the migration");
        assert.match(error.message, /already exists/, "and the database's reason");
        return true;
      },
    );
  } finally {
    for (const dir of sets) rmSync(dir, { recursive: true, force: true });
  }
});

test("a bare DROP COLUMN fails the check before any database is touched", async () => {
  const set = migrationSet("bare-drop", [RELEASE_TABLE, ADD_NOTE, BARE_DROP]);
  try {
    await assert.rejects(
      migrateCheck({
        migrations: set.migrations,
        scratch,
        ownerUrl: "postgresql://nobody@127.0.0.1:1/none",
      }),
      (error: Error) => {
        assert.match(error.message, /^expand-first: 1 finding\(s\)\n/);
        assert.match(
          error.message,
          new RegExp(`${BARE_DROP}/migration.sql:4 expand-first DROP COLUMN`),
        );
        return true;
      },
    );
  } finally {
    rmSync(set.dir, { recursive: true, force: true });
  }
});
