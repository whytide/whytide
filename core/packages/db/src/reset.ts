// `pnpm db:reset`: the slice's database dropped and created again, then migrated. The owner does it
// from the maintenance database `postgres`, so it needs CREATEDB, which `pnpm env:create` gives the
// slice's owner (Prisma's `migrate dev` needs it for its shadow database too). The new database
// comes from template1, pgvector included (deploy/postgres/init.sql), owned by the owner, with every
// grant to come back from the migrations. Nothing may be connected to the database: stop the api,
// the worker and Studio first, or Postgres refuses and says who is connected.
// The migration checks work the same way on a scratch database named after the slice's
// (`<database>_<suffix>`, README "Checks in the pipeline"), which they create and drop; the slice's
// own database is never recreated by a test.
import { createDbClient } from "./client.ts";
import { databaseUrl } from "./env.ts";

/** Drops and recreates the database the owner's connection string names; returns its name. */
export async function recreateDatabase(ownerUrl = databaseUrl("owner")): Promise<string> {
  const database = databaseOf(ownerUrl);
  await asMaintenance(ownerUrl, async (run) => {
    await run(`DROP DATABASE IF EXISTS ${identifier(database)}`);
    await run(`CREATE DATABASE ${identifier(database)}`);
  });
  return database;
}

/** Drops the database the owner's connection string names, closing what is still connected to it. */
export async function dropDatabase(ownerUrl: string): Promise<string> {
  const database = databaseOf(ownerUrl);
  await asMaintenance(ownerUrl, (run) =>
    run(`DROP DATABASE IF EXISTS ${identifier(database)} WITH (FORCE)`),
  );
  return database;
}

/** The database a connection string names. */
export function databaseOf(url: string): string {
  const database = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!database) throw new Error("the connection string names no database");
  return database;
}

/** The same connection string pointing at another database of the same server: a scratch one. */
export function withDatabase(url: string, database: string): string {
  const next = new URL(url);
  next.pathname = `/${encodeURIComponent(database)}`;
  return next.toString();
}

async function asMaintenance(
  ownerUrl: string,
  statements: (run: (sql: string) => Promise<number>) => Promise<unknown>,
): Promise<void> {
  const client = createDbClient("owner", { url: withDatabase(ownerUrl, "postgres") });
  try {
    await statements((sql) => client.$executeRawUnsafe(sql));
  } finally {
    await client.$disconnect();
  }
}

/** A quoted SQL identifier: the slice's name carries hyphens. */
function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
