-- A table for tests/migrate-check.test.ts, as the current tree has it: the release that shipped it
-- (tests/fixtures/releases/edited/) wrote the column "note" here already, which the next fixture
-- migration adds; that edit is what the previous-release check catches.
CREATE TABLE "db_test_release" (
  "id" TEXT NOT NULL,
  CONSTRAINT "db_test_release_pkey" PRIMARY KEY ("id")
);
