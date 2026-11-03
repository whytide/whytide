-- Expands db_test_release: fine from zero, and on a release that shipped the table without "note".
ALTER TABLE "db_test_release" ADD COLUMN "note" TEXT;
