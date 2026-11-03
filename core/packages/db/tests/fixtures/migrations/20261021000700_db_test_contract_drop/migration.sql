-- The same contraction with its marker: the release named stopped reading the column, so dropping it
-- is safe and db:migrate:check accepts it (core/packages/db/README.md "Checks in the pipeline").
-- contract: v0.0.1 stopped reading db_test_release.note
-- DropColumn
ALTER TABLE "db_test_release" DROP COLUMN "note";
