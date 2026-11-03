// A stopgap until alpha-p1-020's withTestDb() (a schema per worker, docs/rules/delivery.md §4) is
// merged: a database of one test file's own, next to the slice's, so that the file does not race
// tests/migrate.test.ts, which drops and recreates the slice's database. Created from the maintenance
// database as the owner, whom `pnpm env:create` gave CREATEDB, migrated with the real migrations and
// dropped at the end; a killed run leaves app_<slice>_<suffix> behind, dropped by the next run.
import { createDbClient, type DbRole, runMigrations } from "../index.ts";
import { databaseUrl } from "../src/env.ts";

export type ScratchDatabase = {
  readonly name: string;
  /** The role's connection string, pointed at the scratch database. */
  url(role: DbRole): string;
  drop(): Promise<void>;
};

export async function scratchDatabase(suffix: string): Promise<ScratchDatabase> {
  const slice = decodeURIComponent(new URL(databaseUrl("owner")).pathname.slice(1));
  const name = `${slice}_${suffix}`;
  const quoted = `"${name.replaceAll('"', '""')}"`;
  const url = (role: DbRole, database = name) => {
    const target = new URL(databaseUrl(role));
    target.pathname = `/${encodeURIComponent(database)}`;
    return target.toString();
  };
  const asOwner = async (statement: string) => {
    const maintenance = createDbClient("owner", { url: url("owner", "postgres") });
    try {
      await maintenance.$executeRawUnsafe(statement);
    } finally {
      await maintenance.$disconnect();
    }
  };
  await asOwner(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
  await asOwner(`CREATE DATABASE ${quoted}`);
  await runMigrations({ url: url("owner") });
  return {
    name,
    url: (role) => url(role),
    drop: () => asOwner(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`),
  };
}
