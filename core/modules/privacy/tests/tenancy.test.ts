// test:tenancy for privacy (docs/rules/security.md §3; core/packages/db README "Register a tenant
// table in the isolation test"): erasure_log is isolated by workspace and append-only for app; the
// log's write and the platform rows' eraser go through the tenant client of the caller's run, and the
// eraser leaves another workspace's rows; and the pipeline check: every tenant table with a person_id
// belongs to a module the deletion script erases, which fails on a fixture table naming it.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { type TenantClient, withTenant } from "@whytide/db";
import {
  asRole,
  assertScoped,
  isolationTest,
  sqlstate,
  tenantTablesWithColumn,
  withTestDb,
} from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { erasingModules } from "../domain/erase/erasers.ts";
import { type ErasureEntry, writeErasureLog } from "../domain/erase/log.ts";
import { erasePlatformRows } from "../domain/erase/platform.ts";

withTestDb();
const principal = servicePrincipal("privacy_test");
const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });
const entry: ErasureEntry = {
  personHash: "a".repeat(64),
  requestedAt: new Date(),
  counts: { contacts: { persons: 1 } },
  performedBy: "operator",
};

isolationTest("erasure_log", {
  async createRow(workspaceId) {
    return { id: await inRun(workspaceId, () => writeErasureLog(entry)) };
  },
  readAs: (workspaceId) =>
    inRun(workspaceId, (tx) => tx.erasureLog.findMany({ where: { personHash: entry.personHash } })),
});

test("app writes and reads the log, and never changes or removes a row", async () => {
  const id = await inRun("wsp_privacy_log", () => writeErasureLog(entry));
  const app = asRole("app");
  const update = app.$executeRaw`UPDATE erasure_log SET performed_by = 'other' WHERE id = ${id}`;
  assert.equal(await sqlstate(update), "42501", "app must not change a log row");
  const remove = app.$executeRaw`DELETE FROM erasure_log WHERE id = ${id}`;
  assert.equal(await sqlstate(remove), "42501", "app must not remove a log row");
  assert.equal(await app.erasureLog.count(), 1);
});

test("the log's write and the platform rows' eraser go through the tenant client of the caller's run", async () => {
  await assertScoped(() => writeErasureLog(entry));
  await assertScoped(() => erasePlatformRows("per_none"));
});

test("erasePlatformRows leaves another workspace's events and answers that name the same id", async () => {
  const [a, b] = ["wsp_privacy_a", "wsp_privacy_b"];
  const app = asRole("app");
  for (const workspaceId of [a, b]) {
    await app.outboxEntry.create({
      data: {
        id: `evt_${workspaceId}`,
        workspaceId,
        eventName: "contacts.lead_reviewed",
        payload: { workspaceId, personId: "per_same", decision: "good_lead" },
      },
    });
    await app.idempotencyRecord.create({
      data: {
        id: `idm_${workspaceId}`,
        workspaceId,
        key: "key_1",
        requestHash: "hash",
        responseStatus: 201,
        responseBody: { personId: "per_same" },
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
  }
  assert.deepEqual(await inRun(a, () => erasePlatformRows("per_same")), {
    outbox: 1,
    idempotency_records: 1,
  });
  const [events, answers] = await Promise.all([
    app.outboxEntry.findMany(),
    app.idempotencyRecord.findMany(),
  ]);
  assert.deepEqual(
    [events.map((row) => row.workspaceId), answers.map((row) => row.workspaceId)],
    [[b], [b]],
  );
});

/** The tenant tables with a person_id in a module the deletion script does not erase. */
function checkErased(dir?: string): void {
  const modules = new Set(erasingModules());
  const missed = tenantTablesWithColumn("person_id", dir)
    .filter((table) => !modules.has(table.module))
    .map(({ table, module }) => `${table} (module ${module})`);
  const message = `a tenant table with a person_id in a module without an eraser: ${missed.join(", ")}; register the module's eraser in core/modules/privacy/domain/erase/erasers.ts`;
  assert.deepEqual(missed, [], message);
}

test("pipeline check: every tenant table with a person_id belongs to a module the deletion script erases", () => {
  // The check reads the schema: the tables it must find are there.
  const found = tenantTablesWithColumn("person_id").map(
    ({ module, table }) => `${module}.${table}`,
  );
  for (const table of ["contacts.leads", "signals.signal_events", "messaging.message_drafts"]) {
    assert.ok(found.includes(table), `${table} has a person_id`);
  }
  checkErased();
});

test("pipeline check: a fixture tenant table with a person_id in a module without an eraser fails it, named", () => {
  const fixture = join(import.meta.dirname, "fixtures", "schema");
  assert.throws(() => checkErased(fixture), /: orphan_notes \(module orphan\);/);
});
