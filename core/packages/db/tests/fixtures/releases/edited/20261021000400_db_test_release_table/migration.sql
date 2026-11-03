-- The same migration as tests/fixtures/migrations/20261021000400_db_test_release_table, as a
-- previous release shipped it, before someone edited it: a database at that release has the column
-- "note" already, and 20261021000500_db_test_release_add_note cannot migrate it forward.
CREATE TABLE "db_test_release" (
  "id" TEXT NOT NULL,
  "note" TEXT,
  CONSTRAINT "db_test_release_pkey" PRIMARY KEY ("id")
);
