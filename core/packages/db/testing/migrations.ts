// Migration sets and scratch databases for the tests that work from zero: a temporary folder with
// the real migrations plus fixtures from tests/fixtures/migrations/, with its prisma.config.ts, and a
// database `<slice database>_<suffix>` the owner creates and drops, so the slice's own database is
// never recreated by a test (docs/rules/delivery.md §4).
import { cpSync } from "node:fs";
import { join } from "node:path";
import { type DbRole, databaseUrl } from "../src/env.ts";
import { temporaryFolder, writePrismaConfig } from "../src/migration-set.ts";
import { packageRoot } from "../src/paths.ts";
import { migrationsDir } from "../src/release-snapshot.ts";
import { databaseOf, dropDatabase, withDatabase } from "../src/reset.ts";

export const fixtureMigrationsDir = join(packageRoot, "tests", "fixtures", "migrations");

export type MigrationSet = {
  /** The temporary folder; remove it when done. */
  readonly dir: string;
  /** The migrations folder inside it. */
  readonly migrations: string;
  /** The prisma.config.ts for runMigrations({ config }). */
  readonly config: string;
};

export type ScratchDatabase = {
  readonly name: string;
  /** The role's connection string pointing at the scratch database. */
  url(role: DbRole): string;
  /** Drops it, closing what is still connected. */
  drop(): Promise<void>;
};

/** The real migrations plus the fixture migrations named, in a temporary folder of its own. */
export function migrationSet(name: string, fixtures: readonly string[] = []): MigrationSet {
  const dir = temporaryFolder(name);
  const migrations = join(dir, "migrations");
  cpSync(migrationsDir, migrations, { recursive: true });
  for (const fixture of fixtures) {
    cpSync(join(fixtureMigrationsDir, fixture), join(migrations, fixture), { recursive: true });
  }
  return { dir, migrations, config: writePrismaConfig(dir, migrations) };
}

/** A database `<slice database>_<suffix>` on the slice's server; `recreateDatabase(url("owner"))` makes it. */
export function scratchDatabase(suffix: string): ScratchDatabase {
  const name = `${databaseOf(databaseUrl("owner"))}_${suffix}`;
  const url = (role: DbRole) => withDatabase(databaseUrl(role), name);
  return {
    name,
    url,
    drop: async () => {
      await dropDatabase(url("owner"));
    },
  };
}
