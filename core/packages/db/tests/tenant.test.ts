// The end-to-end test of alpha-p1-045 (docs/rules/coding.md §11): the tenant transaction and the
// scoped client used the way the api host and the worker will use them, in this file's schema of the
// slice database, with the outbox table as the tenant model. Outside withTenant the tenant client
// throws no_tenant_context; inside, app.workspace_id and app.user_id hold the context for the
// transaction and are gone after it; workspace B never reads, changes or deletes A's rows, an
// explicit where or cursor without workspace_id included; worker code runs it from a workflow's
// input; what the client cannot scope is refused (relations, on a fixture schema; a nested run; raw
// SQL in the unsafe forms or naming the settings); withoutTenant reaches no tenant table and no raw
// SQL. Run with `pnpm -F db test`.
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  collectLogs,
  createLogger,
  currentTenant,
  isAppError,
  servicePrincipal,
  withoutTenant,
} from "@whytide/platform";
import { modelScopes } from "../generated/tenant-models.ts";
import {
  disconnectTenantClient,
  globalClient,
  Prisma,
  type TenantClient,
  tenantClient,
  withTenant,
} from "../index.ts";
import { packageRoot } from "../src/paths.ts";
import { scopeQuery } from "../src/tenant.ts";
import { readModelScopes } from "../src/tenant-models.ts";
import { asRole, assertScoped, isolationTest, withTestDb } from "../testing/index.ts";

withTestDb({ fixtures: ["20261021000800_db_test_tenant_settings"] });

const WSP_A = "wsp_tenant_a";
const WSP_B = "wsp_tenant_b";
const principal = servicePrincipal("tenant_test");
/** A row as a module writes it, leaving the workspace to the client (the types still ask for it). */
type NewRow = Prisma.OutboxEntryUncheckedCreateInput;
type Settings = { workspace_id: string; user_id: string; pid: number };
const inTenant = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });
const fails = (code: string) => (error: unknown) => isAppError(error) && error.code === code;
const refused = (reason: string) => (error: unknown) =>
  fails("tenant_query_refused")(error) && isAppError(error) && error.details?.reason === reason;
/** The settings through the fixture function: the tenant client refuses SQL that names them. */
const settings = async (client: TenantClient) =>
  (await client.$queryRaw<Settings[]>`SELECT * FROM db_test_tenant_settings()`)[0];
let rows = 0;
const newRow = (eventName = "tenant_test.fixture") =>
  ({ id: `obx_tenant_${++rows}`, eventName, payload: {} }) as NewRow;
const createRow = (workspaceId: string) =>
  inTenant(workspaceId, (tx) => tx.outboxEntry.create({ data: newRow() }));
const fixtures = join(packageRoot, "tests", "fixtures", "schema", "tenant-models");

test("outside withTenant the tenant client throws no_tenant_context, as does one kept from its run", async () => {
  assert.throws(() => tenantClient.outboxEntry, fails("no_tenant_context"));
  const kept = await inTenant(WSP_A, async (tx) => tx);
  await assert.rejects(async () => kept.outboxEntry.findMany(), fails("no_tenant_context"));
  await assert.rejects(async () => kept.$queryRaw`SELECT 1`, fails("no_tenant_context"));
  await inTenant(WSP_B, () =>
    assert.rejects(async () => kept.outboxEntry.findMany(), fails("no_tenant_context")),
  );
  await assert.rejects(
    inTenant("", async () => 1),
    fails("no_tenant_context"),
  );
  await assertScoped(() => tenantClient.outboxEntry.findMany());
  const careless = async () => {
    currentTenant();
    return asRole("app").outboxEntry.findMany();
  };
  await assert.rejects(assertScoped(careless), /does not go through the tenant client/);
  await assert.rejects(
    assertScoped(() => inTenant(WSP_A, async () => 1)),
    refused("nested_run"),
    "a command that opens its own run shows why",
  );
});

test("inside withTenant the settings hold the context for the transaction and are gone after it", async () => {
  const [inside, deep] = await inTenant(WSP_A, async (tx) => [
    await settings(tx),
    await settings(tenantClient),
  ]);
  assert.deepEqual(inside, {
    workspace_id: WSP_A,
    user_id: "service:tenant_test",
    pid: inside?.pid,
  });
  assert.deepEqual(deep, inside, "tenantClient runs in the same transaction");
  const [after] = await asRole("app").$queryRaw<Settings[]>`SELECT
    current_setting('app.workspace_id', true) AS workspace_id,
    current_setting('app.user_id', true) AS user_id, pg_backend_pid() AS pid`;
  assert.equal(after?.pid, inside?.pid, "the transaction's connection, back in the pool");
  assert.deepEqual(after, { workspace_id: "", user_id: "", pid: inside?.pid });
});

test("a throw rolls the transaction back", async () => {
  await assert.rejects(
    inTenant(WSP_A, async (tx) => {
      await tx.outboxEntry.create({ data: newRow() });
      throw new Error("rolled back on purpose");
    }),
    /on purpose/,
  );
  assert.equal(await asRole("app").outboxEntry.count(), 0);
});

isolationTest("outbox", {
  createRow,
  readAs: (workspaceId) =>
    inTenant(workspaceId, (tx) =>
      tx.outboxEntry.findMany({ where: { eventName: "tenant_test.fixture" } }),
    ),
});

test("workspace B never reads, changes or deletes A's row, even by its id", async () => {
  const a = await createRow(WSP_A);
  assert.equal(a.workspaceId, WSP_A, "the create got the workspace");
  await inTenant(WSP_B, async (tx) => {
    assert.equal(await tx.outboxEntry.findUnique({ where: { id: a.id } }), null);
    assert.equal(await tx.outboxEntry.findFirst({ where: { id: a.id, workspaceId: WSP_A } }), null);
    assert.equal(await tx.outboxEntry.count({ where: { OR: [{ id: a.id }, { attempts: 0 }] } }), 0);
    const change = { where: { id: a.id }, data: { attempts: 9 } };
    assert.equal((await tx.outboxEntry.updateMany(change)).count, 0);
    assert.equal((await tx.outboxEntry.deleteMany({ where: { id: a.id } })).count, 0);
  });
  await assert.rejects(
    inTenant(WSP_B, (tx) => tx.outboxEntry.update({ where: { id: a.id }, data: { attempts: 9 } })),
    { code: "P2025" },
  );
  await assert.rejects(
    inTenant(WSP_B, (tx) =>
      tx.outboxEntry.upsert({ where: { id: a.id }, create: { ...newRow(), id: a.id }, update: {} }),
    ),
    { code: "P2002" },
  );
  assert.deepEqual(await asRole("app").outboxEntry.findUniqueOrThrow({ where: { id: a.id } }), a);
  await inTenant(WSP_A, async (tx) => {
    assert.equal(await tx.outboxEntry.count({ where: { AND: { eventName: "other" } } }), 0);
  });
});

test("a cursor on A's row finds what a missing one does; B pages its own rows as before", async () => {
  const at = (id: string) => ({ ...newRow(), id });
  await inTenant(WSP_A, (tx) => tx.outboxEntry.create({ data: at("obx_cursor_4") }));
  await inTenant(WSP_B, (tx) =>
    tx.outboxEntry.createMany({ data: ["1", "3", "5"].map((n) => at(`obx_cursor_${n}`)) }),
  );
  await inTenant(WSP_B, async (tx) => {
    const page = async (id: string) =>
      (await tx.outboxEntry.findMany({ cursor: { id }, orderBy: { id: "asc" } })).map((r) => r.id);
    assert.deepEqual(await page("obx_cursor_4"), await page("obx_cursor_missing"));
    assert.deepEqual(await page("obx_cursor_3"), ["obx_cursor_3", "obx_cursor_5"]);
    const count = (id: string) => tx.outboxEntry.count({ cursor: { id }, orderBy: { id: "asc" } });
    assert.equal(await count("obx_cursor_4"), await count("obx_cursor_missing"));
  });
});

test("a write naming another workspace, or moving a row to one, is tenant_mismatch", async () => {
  await inTenant(WSP_B, async (tx) => {
    const elsewhere = { ...newRow(), workspaceId: WSP_A };
    await assert.rejects(tx.outboxEntry.create({ data: elsewhere }), fails("tenant_mismatch"));
    await assert.rejects(
      tx.outboxEntry.createMany({ data: [elsewhere] }),
      fails("tenant_mismatch"),
    );
    const move = { data: { workspaceId: WSP_A } };
    await assert.rejects(tx.outboxEntry.updateMany(move), fails("tenant_mismatch"));
  });
});

test("inside a run: a second run, raw SQL in the unsafe forms or naming the settings are refused", async () => {
  await inTenant(WSP_B, async (tx) => {
    await assert.rejects(
      inTenant(WSP_A, async () => 1),
      refused("nested_run"),
    );
    await assert.rejects(tx.$queryRawUnsafe("SELECT 1"), refused("raw_unsafe"));
    await assert.rejects(tx.$executeRawUnsafe("SELECT 1"), refused("raw_unsafe"));
    await assert.rejects(
      tx.$executeRaw`SELECT set_config('app.workspace_id', ${WSP_A}, true)`,
      refused("raw_settings"),
    );
    await assert.rejects(
      tx.$executeRaw`SELECT set_config(${"app.user_id"}, ${"usr_other"}, true)`,
      refused("raw_settings"),
    );
    assert.deepEqual(await tx.$queryRaw`SELECT 1 AS one`, [{ one: 1 }], "a tagged query runs");
    assert.equal((await settings(tx))?.workspace_id, WSP_B);
  });
});

test("the settings tripwire reads the text with and without comments, quotes, spaces or case", async () => {
  await inTenant(WSP_A, async (tx) => {
    const spellings = [
      tx.$executeRaw`SET "App" . "workspace_id" = 'x'`,
      tx.$executeRaw`SET app/* a /* nested */ comment */.
        user_id = 'x'`,
      tx.$executeRaw`SELECT '/*'; SET app.workspace_id = 'x'; SELECT '*/'`,
    ];
    for (const query of spellings) await assert.rejects(query, refused("raw_settings"));
  });
});

test("a run opened through withoutTenant inside a run is refused as nested_run", async () => {
  const log = createLogger({ destination: collectLogs().destination });
  const second = () =>
    assert.rejects(
      inTenant(WSP_B, async () => 1),
      refused("nested_run"),
    );
  await inTenant(WSP_A, () => withoutTenant("tenant_test", second, { log }));
});

test("inside a run the global client is nested_run, directly or through withoutTenant", async () => {
  const global = globalClient(asRole("app"));
  const log = createLogger({ destination: collectLogs().destination });
  const query = () =>
    assert.rejects(async () => global.outboxEntry.findMany(), refused("nested_run"));
  await inTenant(WSP_A, async () => {
    await query();
    await withoutTenant("tenant_test", query, { log });
  });
});

/** An activity the way the worker host (alpha-p2-050) runs one: the workspace comes from the input. */
async function countEvents(input: { readonly workspaceId: string }) {
  const context = { workspaceId: input.workspaceId, principal: servicePrincipal("worker") };
  return withTenant(
    context,
    async () => {
      const user = (await settings(tenantClient))?.user_id;
      return { user, events: await tenantClient.outboxEntry.count() };
    },
    { client: asRole("app") },
  );
}

test("worker code runs withTenant from a workflow's input, without a request", async () => {
  await inTenant(WSP_A, (tx) => tx.outboxEntry.createMany({ data: [newRow(), newRow()] }));
  await createRow(WSP_B);
  assert.deepEqual(await countEvents({ workspaceId: WSP_A }), {
    user: "service:worker",
    events: 2,
  });
  assert.deepEqual(await countEvents({ workspaceId: WSP_B }), {
    user: "service:worker",
    events: 1,
  });
});

test("withoutTenant reaches no tenant table and no raw SQL, and logs its reason", async () => {
  const global = globalClient(asRole("app"));
  const logs = collectLogs();
  const log = createLogger({ destination: logs.destination });
  await withoutTenant(
    "tenant_test",
    async () => {
      await assert.rejects(async () => global.outboxEntry.findMany(), fails("no_tenant_context"));
      await assert.rejects(async () => global.$queryRaw`SELECT 1`, fails("no_tenant_context"));
      assert.throws(() => tenantClient.outboxEntry, fails("no_tenant_context"));
    },
    { log },
  );
  assert.deepEqual(
    logs.lines().map(({ reason }) => reason),
    ["tenant_test"],
  );
  await assert.rejects(async () => global.outboxEntry.findMany(), fails("no_tenant_context"));
});

test("the model list is generated with the client: every model, tenant by marker or column", () => {
  assert.deepEqual(Object.keys(modelScopes).sort(), Object.values(Prisma.ModelName).sort());
  assert.deepEqual(modelScopes, readModelScopes(), "generated from the schema as it is");
  for (const model of ["OutboxEntry", "CostEvent", "IdempotencyRecord"]) {
    assert.deepEqual(modelScopes[model], { tenant: true, field: "workspaceId", relations: [] });
  }
  assert.deepEqual(readModelScopes(fixtures), {
    Person: { tenant: true, field: "workspaceId", relations: ["plan"] },
    Draft: { tenant: true, field: "wsId", relations: [] },
    Lead: { tenant: true, field: null, relations: [] },
    Plan: { tenant: false, field: null, relations: ["persons"] },
    Note: { tenant: true, field: "workspaceId", relations: [] },
  });
});

test("a relation in any argument is refused by both guards; the rest is scoped or runs as written", () => {
  const scopes = readModelScopes(fixtures);
  const run = (model: string, operation: string, args: object, workspaceId?: string) => () =>
    scopeQuery(scopes, model, operation, args as Record<string, unknown>, workspaceId);
  const viaPerson: [string, object][] = [
    ["findMany", { where: { plan: { is: { id: "p" } } } }],
    ["findMany", { where: { OR: [{ id: "x" }, { NOT: { AND: [{ plan: null }] } }] } }],
    ["findMany", { cursor: { id: "x", plan: { id: "p" } } }],
    ["findMany", { orderBy: [{ id: "asc" }, { plan: { id: "asc" } }] }],
    ["findUnique", { where: { id: "x" }, select: { plan: true } }],
    ["findMany", { select: { id: true, _count: true } }],
    ["findMany", { include: { plan: true } }],
    ["create", { data: { id: "x", plan: { connect: { id: "p" } } } }],
    ["updateMany", { data: { plan: { disconnect: true } } }],
    ["upsert", { where: { id: "x" }, create: { id: "x", plan: { create: { id: "p" } } } }],
    ["upsert", { where: { id: "x" }, create: { id: "x" }, update: { plan: { connect: {} } } }],
  ];
  for (const [operation, args] of viaPerson) {
    assert.throws(run("Person", operation, args, WSP_A), refused("relation"), JSON.stringify(args));
  }
  for (const workspaceId of [WSP_A, undefined]) {
    const include = { where: { id: "p" }, include: { persons: true } };
    assert.throws(run("Plan", "findUnique", include, workspaceId), refused("relation"));
    const remove = { where: { id: "p" }, data: { persons: { deleteMany: {} } } };
    assert.throws(run("Plan", "update", remove, workspaceId), refused("relation"));
  }
  assert.deepEqual(run("Plan", "findMany", { where: { id: "p" } })(), { where: { id: "p" } });
  assert.deepEqual(run("Draft", "findMany", { where: { id: "d" }, cursor: { id: "d" } }, WSP_A)(), {
    where: { id: "d", AND: [{ wsId: WSP_A }] },
    cursor: { id: "d", wsId: WSP_A },
  });
  assert.throws(run("Person", "findMany", {}), fails("no_tenant_context"));
  assert.throws(run("Lead", "findMany", {}, WSP_A), refused("no_workspace_column"));
  assert.throws(run("Ghost", "findMany", {}, WSP_A), refused("unknown_model"));
  assert.throws(run("Person", "findRaw", {}, WSP_A), refused("unknown_operation"));
});

test("disconnectTenantClient ends the default client; the next run opens a new one", async () => {
  await disconnectTenantClient();
  const one = () => withTenant({ workspaceId: WSP_A, principal }, (tx) => tx.$queryRaw`SELECT 1`);
  await one();
  await disconnectTenantClient();
  await one();
  await disconnectTenantClient();
});
