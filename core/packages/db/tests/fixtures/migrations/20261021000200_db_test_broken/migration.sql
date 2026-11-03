-- A migration that cannot apply, for tests/migrate.test.ts: runMigrations() must throw, so that the
-- api does not listen, and the next run must refuse until the failure is resolved.
CREATE TABLE "db_test_broken" (
  "id" TEXT NOT NULL REFERENCES "db_test_no_such_table" ("id")
);
