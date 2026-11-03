-- The fixture tenant table of tests/migrate.test.ts: the test applies it after the real migrations,
-- as the owner, the way every module's migration runs, to prove the default privileges that
-- 20261021000000_db_roles sets. It lives here and never under prisma/migrations/, so no real database
-- gets it.
CREATE TABLE "db_test_tenant_fixture" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "note" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "db_test_tenant_fixture_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "db_test_tenant_fixture_workspace_id_idx" ON "db_test_tenant_fixture" ("workspace_id");
