# ADR 0003: the database roles from the first migration, in alpha

| | |
|---|---|
| **Status** | accepted |
| **Date** | 2026-10-21 |
| **Deciders** | the implementer of alpha-p1-010, a coding agent, as the task's open question allowed; the architecture had decided the when |

## Context

Two database roles bound what a bug or a bypass in the tenant API can do: `app`, for the api and the worker, which can never write a plan, a subscription or a grant, and `billing_writer`, for the seeder, which can (architecture §6, security §3). The planning repository's docs/15 §11 put the role split in zeta; the architecture puts the roles in the first migration, and the rules say so too. Roles are cluster-wide in Postgres while a migration's SQL is static and runs once per database, and a migration can hold no password. In development every worktree has its own database on one shared Postgres (delivery §2), and the task left open whether each slice gets login roles of its own or shares one `app` login.

## Decision

- **The roles exist from alpha**, created by the first migration, `20261021000000_db_roles`, before any product table: the architecture wins over docs/15 §11. Every table created after it is covered without a later grant pass, and the pipeline's role test (alpha-p1-020) can run from the start.
- **The migration creates group roles; the environment creates login roles.** `app` and `billing_writer` are `NOLOGIN` roles, created when missing, shared by every database of the cluster; the migration grants them `CONNECT` and `USAGE` on `public`, and sets the owner's default privileges: `SELECT, INSERT, UPDATE, DELETE` on every later table to `app`, `USAGE, SELECT` on every sequence to `app`, nothing to `billing_writer`. A module's migration restricts or grants per table with plain `GRANT` and `REVOKE`. Login roles, which carry passwords, are members of the groups and come from the environment: `pnpm env:create` in development, the deployment's setup later.
- **Login roles per slice in development**: `owner_<slice>`, `app_<slice>` and `billing_writer_<slice>`, with the stack's password. One shared `app` login would open every slice's database to every worktree's connection string; a password per role in a localhost-only stack whose superuser already carries that password would add ceremony and nothing else.
- **The owner is a plain role** that owns the database: no superuser, no `CREATEROLE`, with `CREATEDB` so that `pnpm db:reset` can drop and recreate the slice's database from the maintenance database (the recreated database comes from `template1`, pgvector included) and Prisma's `migrate dev` can make its shadow database. On a bare cluster, where nothing created the group roles before the first migration, the migrating role also needs `CREATEROLE`; the development stack never does, because `env:create` creates the groups first.
- **The runner is Prisma's own `migrate deploy`** in a child process, with the applied names read from its output: Prisma 7 has no programmatic migrate API, and a second implementation of its bookkeeping would drift from `migrate dev`, `migrate status` and `migrate resolve`.

Considered and dropped: login roles created by the migration (a password cannot be static SQL, and a cluster-wide role created per database collides); the role split in zeta as docs/15 §11 said (every table created before would need a grant pass, and the pipeline could not prove the bound in the meantime); `db:reset` as a schema drop (`DROP SCHEMA public CASCADE` takes pgvector with it, and the owner may not install an untrusted extension again).

## Consequences

- Every migration runs as the owner, always: default privileges belong to the role that set them, so a table created by another role is invisible to `app` and the role test says so.
- A module whose table `app` must not write, or `billing_writer` must write, says so in its own migration (the credits task first).
- The deploy task creates the production login roles with their own secrets the way `env:create` does, and gives the migrating role `CREATEROLE` or creates the group roles beforehand.
- The migration's `CREATE ROLE` branch runs only on a bare cluster; the development stack and the GitLab job never exercise it. A later check on a fresh cluster (the throwaway stack of the deploy tests) could.
- `docs/15 §11` in the planning repository still says zeta; the owner updates it.
