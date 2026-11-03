-- Runs once, on the first start of the postgres service (an empty volume), as the superuser and
-- connected to the product database `app` (alpha-p0-030). Temporal's two databases first, so they
-- stay plain; then pgvector on `app` and on template1, so every database created later, like
-- `app_<worktree>` from `pnpm env:create`, starts with it and no other role needs superuser rights.
CREATE DATABASE temporal;
CREATE DATABASE temporal_visibility;
CREATE EXTENSION IF NOT EXISTS vector;
\connect template1
CREATE EXTENSION IF NOT EXISTS vector;
