// The one way to a Prisma client: as one of the three roles, through the pg driver adapter Prisma 7
// requires. The api and the worker connect as `app`, the seeder as `billing_writer`, migrations as the
// owner (docs/rules/security.md §3); a client never changes its role.
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client.ts";
import { type DbRole, databaseUrl } from "./env.ts";

const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;

export type CreateDbClientOptions = {
  /** Another connection string for the role, for a tool; the default is the role's variable. */
  readonly url?: string;
  /**
   * The schema the client works in instead of `public`: a test worker's (README, "Register a tenant
   * table in the isolation test"). Generated queries name it; raw SQL finds it first on the
   * connection's search_path.
   */
  readonly schema?: string;
};

/**
 * A Prisma client connected as `role`, from the role's variable in the environment or .env.local.
 * The caller owns it and calls `$disconnect()` when done.
 */
export function createDbClient(role: DbRole, options: CreateDbClientOptions = {}): PrismaClient {
  const connectionString = options.url ?? databaseUrl(role);
  const schema = options.schema;
  if (schema === undefined) {
    return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  }
  if (!SCHEMA.test(schema)) {
    throw new Error(`"${schema}" is not a schema name: lowercase letters, digits and _`);
  }
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, options: `-c search_path=${schema}` }, { schema }),
  });
}
