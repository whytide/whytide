// The three connection strings, a config block of the platform (docs/rules/coding.md §8): declared
// here once, with Zod, as the `packages/db` block of deploy/.env.example, which `pnpm env:check`
// compares with this file. Each one is optional in the block, because a process holds only the
// strings it uses: the api the owner's and `app`'s, the worker `app`'s, the seeder `billing_writer`'s.
// databaseUrl(role) is the loud failure, naming the variable and `pnpm env:create`, never a value.
import { defineConfig, type Env, isAppError, secret } from "@whytide/platform";
import { z } from "zod";
import { loadEnvLocal } from "./paths.ts";

/** The role a connection runs as (docs/rules/security.md §3, docs/architecture.md §6). */
export type DbRole = "owner" | "app" | "billing_writer";

const variables = {
  owner: "DATABASE_URL_OWNER",
  app: "DATABASE_URL",
  billing_writer: "DATABASE_URL_BILLING_WRITER",
} as const satisfies Record<DbRole, string>;

/** A Postgres connection string, a secret: the login role's password is inside. */
const connectionString = z.url({ protocol: /^postgres(ql)?$/ }).optional();

/** The block, read from `env`; a malformed string fails naming the variable, never the value. */
function dbConfig(env: Env) {
  try {
    return defineConfig(
      "packages/db",
      {
        DATABASE_URL_OWNER: secret(connectionString),
        DATABASE_URL: secret(connectionString),
        DATABASE_URL_BILLING_WRITER: secret(connectionString),
      },
      env,
    );
  } catch (error) {
    if (isAppError(error) && error.code === "config_invalid") {
      const variables = error.details?.variables;
      const named = Array.isArray(variables) ? variables.join("; ") : error.code;
      throw new Error(
        `${named}; expected a Postgres connection string like the packages/db block of deploy/.env.example`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * The connection string of a role, from `env` (the process environment, .env.local loaded first);
 * throws, naming the variable and `pnpm env:create`, when nothing set it.
 */
export function databaseUrl(role: DbRole, env: Env = process.env): string {
  if (env === process.env) loadEnvLocal();
  const name = variables[role];
  const url = dbConfig(env)[name];
  if (url === undefined) {
    throw new Error(
      `${name} is not set: run pnpm env:create for this worktree (deploy/README.md) or set it in the environment`,
    );
  }
  return url;
}
