// The unit test of the expand-first parser (alpha-p1-020, docs/rules/coding.md §11): a DROP TABLE, a
// column drop or a rename of a column or a table is a contraction and needs a "-- contract: <release>"
// line right above it; a constraint, a default, an index, or a word inside a comment, a string or a
// DO block is not one. The scanner: block comments, strings, quoted identifiers, several statements on
// a line and a last statement without its semicolon. Then the fixture migrations: exactly the bare
// drop is found, and the real migrations are clean.
import assert from "node:assert/strict";
import test from "node:test";
import {
  checkExpandFirst,
  expandFirstFindings,
  formatExpandFirstFinding,
} from "../src/expand-first.ts";
import { migrationsDir } from "../src/release-snapshot.ts";
import { fixtureMigrationsDir } from "../testing/index.ts";

const kinds = (sql: string) => expandFirstFindings("m.sql", sql).map((f) => f.statement);
const lines = (sql: string) => expandFirstFindings("m.sql", sql).map((f) => f.line);

test("a bare DROP TABLE, column drop or rename is a finding, in every spelling", () => {
  assert.deepEqual(kinds('DROP TABLE "persons";'), ["DROP TABLE"]);
  assert.deepEqual(kinds('drop table if exists "persons" cascade;'), ["DROP TABLE"]);
  assert.deepEqual(kinds('ALTER TABLE "persons" DROP COLUMN "full_name";'), ["DROP COLUMN"]);
  assert.deepEqual(kinds('ALTER TABLE "persons" DROP COLUMN IF EXISTS "full_name";'), [
    "DROP COLUMN",
  ]);
  assert.deepEqual(kinds('ALTER TABLE "persons" DROP "full_name";'), ["DROP COLUMN"]);
  assert.deepEqual(kinds('ALTER TABLE "persons"\n  ADD COLUMN "x" TEXT,\n  DROP COLUMN "y";'), [
    "DROP COLUMN",
  ]);
  assert.deepEqual(
    kinds('ALTER TABLE "persons" ALTER COLUMN "score" DROP DEFAULT, DROP COLUMN "y";'),
    ["DROP COLUMN"],
    "a DROP DEFAULT before the column drop hides nothing",
  );
  assert.deepEqual(kinds('ALTER TABLE ONLY public."persons" DROP COLUMN "y";'), ["DROP COLUMN"]);
  assert.deepEqual(kinds('ALTER TABLE "persons" RENAME COLUMN "full_name" TO "name";'), [
    "RENAME COLUMN",
  ]);
  assert.deepEqual(kinds('ALTER TABLE "persons" RENAME "full_name" TO "name";'), ["RENAME COLUMN"]);
  assert.deepEqual(kinds('ALTER TABLE "persons" RENAME TO "people";'), ["RENAME TABLE"]);
  assert.deepEqual(kinds('alter table if exists public."persons" rename to "people";'), [
    "RENAME TABLE",
  ]);
  assert.deepEqual(lines('CREATE TABLE "a" ("id" TEXT);\n\n-- DropTable\nDROP TABLE "b";\n'), [4]);
});

test("what is not a contraction, or not read as one, passes", () => {
  for (const sql of [
    'ALTER TABLE "persons" DROP CONSTRAINT "persons_email_key";',
    'ALTER TABLE "persons" ALTER COLUMN "score" DROP DEFAULT;',
    'ALTER TABLE "persons" ALTER COLUMN "score" DROP NOT NULL;',
    'ALTER TABLE "persons" ALTER COLUMN "n" DROP IDENTITY;',
    'ALTER TABLE "persons" ALTER COLUMN "n" DROP EXPRESSION;',
    'ALTER TABLE "persons" RENAME CONSTRAINT "persons_email_key" TO "persons_email_uniq";',
    'ALTER INDEX "persons_email_key" RENAME TO "persons_email_idx";',
    'DROP INDEX "persons_workspace_id_idx";',
    'DROP TYPE "kind";',
    '-- DROP TABLE persons later\nCREATE TABLE "a" ("id" TEXT); -- not a drop column\n',
    "INSERT INTO notes (body) VALUES ('DROP TABLE persons; ALTER TABLE x DROP COLUMN y');",
    "DO $$\nBEGIN\n  RAISE NOTICE 'x';\nEND\n$$;",
    // Not read as contractions (README "Checks in the pipeline"): a type change, NOT NULL, an enum's
    // rename, and DDL inside a DO block, which is a string to the scanner.
    'ALTER TABLE "persons" ALTER COLUMN "score" TYPE BIGINT;',
    'ALTER TABLE "persons" ALTER COLUMN "score" SET NOT NULL;',
    'ALTER TYPE "kind" RENAME TO "kinds";',
    "DO $body$\nBEGIN\n  ALTER TABLE persons DROP COLUMN x;\nEND\n$body$;",
  ]) {
    assert.deepEqual(kinds(sql), [], sql);
  }
});

test("the contract marker right above the statement, naming a release, allows it", () => {
  assert.deepEqual(
    kinds(
      '-- contract: v0.3.0 stopped reading persons.full_name\n-- DropColumn\nALTER TABLE "persons" DROP COLUMN "full_name";',
    ),
    [],
  );
  assert.deepEqual(kinds('-- contract (0.3.0)\nDROP TABLE "drafts";'), []);
  assert.deepEqual(kinds('-- Contract: v1.2.3\nDROP TABLE "drafts";'), []);
  assert.deepEqual(kinds('-- contract: V1.2.3\nDROP TABLE "drafts";'), [], "an upper-case V");
  assert.deepEqual(
    kinds(
      '-- contract: v0.3.0 renamed in the api\nALTER TABLE "persons" RENAME "full_name" TO "name";',
    ),
    [],
  );
  assert.deepEqual(kinds('-- contract: v0.3.0\nALTER TABLE "persons" RENAME TO "people";'), []);
  assert.deepEqual(
    kinds('-- contract: v0.3.0\n/* the api reads people since */\nDROP TABLE "persons";'),
    [],
    "a block comment line between the marker and the statement detaches nothing",
  );
  const noRelease = expandFirstFindings("m.sql", '-- contract: safe now\nDROP TABLE "drafts";');
  assert.equal(noRelease.length, 1);
  assert.match(noRelease[0]?.message ?? "", /names no release/);
  assert.deepEqual(
    kinds('/* contract: v0.3.0 */\nDROP TABLE "drafts";'),
    ["DROP TABLE"],
    "the marker is a -- line",
  );
  const detached = expandFirstFindings(
    "m.sql",
    '-- contract: v0.3.0\n\nDROP TABLE "drafts";\nDROP TABLE "notes";',
  );
  assert.deepEqual(
    detached.map((f) => f.line),
    [3, 4],
    "a blank line detaches the marker; a marker covers one statement",
  );
  assert.match(
    formatExpandFirstFinding(detached[0] as (typeof detached)[0]),
    /^m\.sql:3 expand-first DROP TABLE/,
  );
  const twoOnOneLine = expandFirstFindings(
    "m.sql",
    '-- contract: v0.3.0\nDROP TABLE "drafts"; DROP TABLE "notes";',
  );
  assert.deepEqual(
    twoOnOneLine.map((f) => [f.line, f.statement]),
    [[2, "DROP TABLE"]],
    "two statements on one line: the marker covers the first",
  );
});

test("the scanner: block comments, strings, identifiers and a last statement without a semicolon", () => {
  assert.deepEqual(kinds('DROP TABLE "persons"'), ["DROP TABLE"], "no semicolon at the end");
  assert.deepEqual(kinds('CREATE TABLE "a" ("id" TEXT);\nALTER TABLE "a" DROP COLUMN "x"\n'), [
    "DROP COLUMN",
  ]);
  assert.deepEqual(kinds('/* DROP TABLE "a"; */ CREATE TABLE "a" ("id" TEXT);'), []);
  assert.deepEqual(kinds('/* a note\n   DROP TABLE "a";\n */\nCREATE TABLE "a" ("id" TEXT);'), []);
  assert.deepEqual(
    kinds('/* outer /* nested */ DROP TABLE "a"; */ CREATE TABLE "a" ("id" TEXT);'),
    [],
    "block comments nest",
  );
  assert.deepEqual(kinds('ALTER TABLE "a" /* why */ DROP COLUMN "x";'), ["DROP COLUMN"]);
  assert.deepEqual(
    kinds("INSERT INTO notes (body) VALUES ('/*'); DROP TABLE \"a\";"),
    ["DROP TABLE"],
    "a comment opener inside a string is text",
  );
  assert.deepEqual(
    kinds("INSERT INTO notes (body) VALUES (E'it''s /* \\' here'); DROP TABLE \"a\";"),
    ["DROP TABLE"],
    "an escape string with a backslashed quote",
  );
  assert.deepEqual(
    kinds('CREATE TABLE "a" ("id" TEXT); DROP TABLE "b";'),
    ["DROP TABLE"],
    "two statements on one line",
  );
  assert.deepEqual(
    kinds('ALTER TABLE "a; DROP TABLE b" ADD COLUMN "x" TEXT;'),
    [],
    "a semicolon inside a quoted identifier",
  );
  assert.deepEqual(
    lines('CREATE TABLE "a" ("id" TEXT);\r\n\r\n-- DropTable\r\nDROP TABLE "b";\r\n'),
    [4],
    "CRLF line ends",
  );
  assert.deepEqual(lines('CREATE TABLE "a" (\n  "id" TEXT\n);\nDROP TABLE "b"'), [4]);
});

test("the fixture migrations: exactly the bare drop; the real migrations: clean", () => {
  const findings = checkExpandFirst(fixtureMigrationsDir);
  assert.deepEqual(
    findings.map((f) => f.path.split("/").at(-2)),
    ["20261021000600_db_test_bare_drop"],
  );
  assert.deepEqual(checkExpandFirst(migrationsDir), []);
  assert.deepEqual(checkExpandFirst(`${migrationsDir}-missing`), []);
});
