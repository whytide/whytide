// `test:roles` (alpha-p1-020, on the real tables since alpha-p3-050; docs/rules/security.md §3,
// docs/architecture.md §6 and §10): in this file's schema of the slice database, migrated with the
// credits migration and its grants, `app` cannot insert, update or delete a plan, a subscription, a
// grant, a price or a balance, while it reads them, nor delete a usage row, move it to another
// organization or workspace, make it negative or change it once settled (credits_reserve);
// `billing_writer` inserts and updates the first four, never below zero, and deletes none, and the
// trigger moves the balance it cannot write. Last,
// the schema's start: the statements the roles migration runs on `public`, replayed with the schema's
// name, and no other migration naming `public`, which a test schema would silently miss.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { migrationFolders, migrationsDir } from "../src/release-snapshot.ts";
import { sqlStatements } from "../src/sql-statements.ts";
import {
  asRole,
  fixtureMigrationsDir,
  ROLES_MIGRATION,
  schemaGrantStatements,
  sqlstate,
  withTestDb,
} from "../testing/index.ts";

/** The tables billing_writer writes, each with one row of it and one change to that row. */
const TABLES = ["plans", "subscriptions", "credit_grants", "price_list"] as const;
const PERIOD = `'2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'`;
const rows: Record<(typeof TABLES)[number], { insert: string; update: string }> = {
  plans: {
    insert: `("id", "code", "name", "monthly_allowance", "is_fixed") VALUES ('plan_test', 'self_hosted', 'self_hosted', 10000000, true)`,
    update: `"monthly_allowance" = 20000000`,
  },
  subscriptions: {
    insert: `("id", "organization_id", "plan_id", "period_start", "period_end") VALUES ('sub_test', 'org_test', 'plan_test', ${PERIOD})`,
    update: `"status" = 'cancelled'`,
  },
  credit_grants: {
    insert: `("id", "organization_id", "subscription_id", "amount", "reason", "period_start", "period_end") VALUES ('grant_test', 'org_test', 'sub_test', 10000000, 'allowance', ${PERIOD})`,
    update: `"amount" = 20000000`,
  },
  price_list: {
    insert: `("id", "action", "credits", "unit", "version", "effective_from") VALUES ('pl_test', 'test.action', 1, 'call', 1, '2026-10-01T00:00:00Z')`,
    update: `"credits" = 2`,
  },
};
const NAMES_PUBLIC = /\bSCHEMA\s+public\b/i;

withTestDb();

test("app cannot insert, update or delete a plan, a subscription, a grant, a price or a balance", async () => {
  const app = asRole("app");
  const inserts: Record<string, string> = {
    ...Object.fromEntries(TABLES.map((table) => [table, rows[table].insert])),
    credit_balances: `("id", "organization_id") VALUES ('bal_test', 'org_test')`,
  };
  for (const [table, insert] of Object.entries(inserts)) {
    assert.equal(
      await sqlstate(app.$executeRawUnsafe(`INSERT INTO "${table}" ${insert}`)),
      "42501",
      `app must not insert into ${table}`,
    );
    assert.equal(
      await sqlstate(app.$executeRawUnsafe(`UPDATE "${table}" SET "id" = "id"`)),
      "42501",
      `app must not update ${table}`,
    );
    assert.equal(
      await sqlstate(app.$executeRawUnsafe(`DELETE FROM "${table}"`)),
      "42501",
      `app must not delete from ${table}`,
    );
    assert.deepEqual(
      await app.$queryRawUnsafe(`SELECT "id" FROM "${table}"`),
      [],
      `app reads ${table}`,
    );
  }
  assert.equal(
    await sqlstate(app.$executeRawUnsafe(`DELETE FROM "credit_usage"`)),
    "42501",
    "app must not delete a usage row",
  );
  await app.$executeRawUnsafe(
    `INSERT INTO "credit_usage" ("id", "organization_id", "workspace_id", "action", "quantity", "credits", "idempotency_key", "lease_expires_at", "subject_ref") VALUES ('usage_test', 'org_test', 'wsp_test', 'test.action', 1, 1, 'key_test', now(), 'lead_test')`,
  );
  const update = (set: string) =>
    sqlstate(app.$executeRawUnsafe(`UPDATE "credit_usage" SET ${set}`));
  assert.equal(await update(`"organization_id" = 'org_other'`), "42501", "app moves no usage row");
  assert.equal(await update(`"workspace_id" = 'wsp_other'`), "42501", "app moves no usage row");
  assert.equal(await update(`"credits" = -1`), "23514", "no negative credits");
  assert.equal(await update(`"credits" = 2`), "23514", "a usage row never rises");
  assert.equal(await update(`"status" = 'committed', "settled_at" = now()`), undefined);
  assert.equal(await update(`"status" = 'released'`), "23514", "a settled row stays settled");
});

test("billing_writer inserts and updates a plan, a subscription, a grant and a price, deletes none, and app reads them", async () => {
  const billing = asRole("billing_writer");
  const who = await billing.$queryRawUnsafe<{ user: string }[]>("SELECT current_user AS user");
  assert.match(who[0]?.user ?? "", /billing_writer/, "connected as a billing_writer role");
  for (const table of TABLES) {
    assert.equal(
      await billing.$executeRawUnsafe(`INSERT INTO "${table}" ${rows[table].insert}`),
      1,
      `billing_writer inserts into ${table}`,
    );
    assert.equal(
      await billing.$executeRawUnsafe(`UPDATE "${table}" SET ${rows[table].update}`),
      1,
      `billing_writer updates ${table}`,
    );
    assert.equal(
      await sqlstate(billing.$executeRawUnsafe(`DELETE FROM "${table}"`)),
      "42501",
      `billing_writer must not delete from ${table}`,
    );
  }
  assert.equal(
    await sqlstate(billing.$queryRawUnsafe(`SELECT "granted" FROM "credit_balances"`)),
    "42501",
    "billing_writer does not read the balances",
  );
  for (const negative of [
    `"plans" SET "monthly_allowance" = -1`,
    `"credit_grants" SET "amount" = -1`,
  ]) {
    assert.equal(
      await sqlstate(billing.$executeRawUnsafe(`UPDATE ${negative}`)),
      "23514",
      negative,
    );
  }
  const app = asRole("app");
  for (const table of TABLES) {
    const seen = await app.$queryRawUnsafe<{ id: string }[]>(`SELECT "id" FROM "${table}"`);
    assert.equal(seen.length, 1, `app reads the row of ${table}`);
  }
  assert.deepEqual(
    await app.$queryRawUnsafe(
      `SELECT "organization_id", trim_scale("granted")::text AS "granted" FROM "credit_balances"`,
    ),
    [{ organization_id: "org_test", granted: "20000000" }],
    "the trigger keeps the balance billing_writer cannot write",
  );
});

test("a test schema starts with the roles migration's statements on public, which no other migration names", () => {
  const statements = schemaGrantStatements("test_x");
  assert.ok(
    statements.some((s) => /^GRANT USAGE ON SCHEMA "test_x" TO app, billing_writer$/.test(s)),
    statements.join("\n"),
  );
  assert.equal(
    statements.filter((s) => s.startsWith('ALTER DEFAULT PRIVILEGES IN SCHEMA "test_x" GRANT'))
      .length,
    2,
    "the default privileges on tables and on sequences",
  );
  for (const statement of statements) {
    assert.doesNotMatch(statement, NAMES_PUBLIC, "every statement is rewritten to the schema");
  }
  assert.equal(
    migrationFolders(migrationsDir)[0],
    ROLES_MIGRATION,
    "the roles migration is the first",
  );
  for (const dir of [migrationsDir, fixtureMigrationsDir]) {
    for (const folder of migrationFolders(dir).filter((name) => name !== ROLES_MIGRATION)) {
      const sql = readFileSync(join(dir, folder, "migration.sql"), "utf8");
      for (const statement of sqlStatements(sql)) {
        assert.doesNotMatch(
          statement.text,
          NAMES_PUBLIC,
          `${folder} names schema public: withTestDb() replays the roles migration's statements only, so a test schema would miss it (README "Register a tenant table in the isolation test")`,
        );
      }
    }
  }
});
