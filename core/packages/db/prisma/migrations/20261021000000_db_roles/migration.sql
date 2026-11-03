-- alpha-p1-010: the database roles, from the first migration (docs/rules/security.md §3,
-- docs/architecture.md §6, docs/adr/0003-roles-from-alpha.md). Prisma cannot say roles, so this is
-- hand-written SQL (docs/rules/coding.md §5); prisma/schema/_roles.prisma points here. It runs once per
-- database, as the owner, like every migration.

-- `app` and `billing_writer` are group roles without a login, shared by every database of the cluster:
-- created here when nothing created them before (on a bare cluster the migrating role needs CREATEROLE
-- for that; the development stack's `pnpm env:create` creates them first, so that a slice's login roles
-- can join them). A login role is a member of one of them: per slice from env:create in development,
-- per deployment later. Both may connect to this database; nothing more by default.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'billing_writer') THEN
    CREATE ROLE billing_writer NOLOGIN;
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app, billing_writer', current_database());
END
$$;

-- The schema: visible to both, created in by the owner only (what Postgres 15 and later do already).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app, billing_writer;

-- Every table a later migration creates as the owner in `public`: `app` reads and writes its rows and
-- uses its sequences; `billing_writer` gets nothing. A module's migration restricts or grants per
-- table with plain GRANT and REVOKE, in the same way (core/packages/db/README.md).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app;
