-- A contraction without its marker, for tests/migrate-check.test.ts and tests/expand-first.test.ts:
-- db:migrate:check fails on it before touching a database.
-- DropColumn
ALTER TABLE "db_test_release" DROP COLUMN "note";
