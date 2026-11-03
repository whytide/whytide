-- alpha-p1-135: the schema of Mastra's storage (core/packages/ai, README "The Mastra instance";
-- decisions §14 rule 3): workflow snapshots and evals, without personal data, since an agent's input
-- has none. Mastra creates and upgrades its own tables there when the worker starts, connected as
-- `app`, so `app` may create in it; no migration names a table of it, and prisma/schema/ai.prisma
-- points here. `billing_writer` gets nothing. The tenancy rules exclude the schema by name
-- (src/tenancy-check.ts).
CREATE SCHEMA IF NOT EXISTS "mastra";
GRANT USAGE, CREATE ON SCHEMA "mastra" TO app;
