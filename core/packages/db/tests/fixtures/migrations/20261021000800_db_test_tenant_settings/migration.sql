-- The tenant settings for tests/tenant.test.ts to read inside withTenant, where the tenant client
-- refuses raw SQL that names them. It lives here and never under prisma/migrations/, so no real
-- database gets it.
CREATE FUNCTION "db_test_tenant_settings"()
RETURNS TABLE ("workspace_id" TEXT, "user_id" TEXT, "pid" INTEGER)
LANGUAGE sql STABLE
AS $$ SELECT current_setting('app.workspace_id', true), current_setting('app.user_id', true), pg_backend_pid() $$;
