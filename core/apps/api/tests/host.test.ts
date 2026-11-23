// The end-to-end test of alpha-p2-010 (docs/rules/coding.md §11): the host started the way main.ts
// starts it, on the fake authentication adapter and the fixture module, in a schema of the worktree's
// database, answering real HTTP on 127.0.0.1; a broken fixture migration in a scratch schema of it;
// and the module list after `pnpm module:new`. Run with `pnpm -F api test`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { createDbClient, databaseUrl } from "@whytide/db";
import { asRole, migrationSet, withTestDb } from "@whytide/db/testing";
import {
  checkLogLines,
  collectLogs,
  createLogger,
  isAppError,
  type LogSchema,
  logSchema,
} from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import type { ModuleLoader } from "../src/modules.ts";
import { type Api, start } from "../src/start.ts";
import { StrayApi } from "./fixtures/guard/guard.controller.ts";
import { FIXTURE_WORKSPACE } from "./fixtures/module/index.ts";

const db = withTestDb({ fixtures: ["20261021000800_db_test_tenant_settings"] });
const BROKEN = "20261021000200_db_test_broken";
const apiDir = resolve(import.meta.dirname, "..", "..");
const logs = collectLogs();
const log = createLogger({ destination: logs.destination });
const fixture: ModuleLoader = { name: "fixture", load: () => import("./fixtures/module/index.ts") };
/** alpha-p3-030's routes for the guard; the fixture's workspaceResolver answers for them. */
const guard: ModuleLoader = { name: "guard", load: () => import("./fixtures/guard/index.ts") };
const fixturePath = `/v1/workspaces/${FIXTURE_WORKSPACE}/fixture`;
let api: Api;
let cookie: string;

/** The owner's connection string, into a schema of the slice's database. */
function ownerUrl(schema: string): string {
  const url = new URL(databaseUrl("owner"));
  url.searchParams.set("schema", schema);
  return url.toString();
}

/** A request to the api; every answer carries the request id, whatever its status. */
async function call(path: string, init: RequestInit = {}, base = api.url) {
  const res = await fetch(new URL(path, base), init);
  const requestId = res.headers.get("x-request-id") ?? "";
  assert.match(requestId, /^[0-9a-f-]{36}$/, `${path} answers without a request id`);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : undefined, requestId };
}

before(async () => {
  api = await start({
    port: 0,
    log,
    modules: [fixture, guard],
    migrations: { url: ownerUrl(db.schema) },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
  cookie = signInAs("usr_fixture")
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
});
after(() => api?.close());

test("GET /health answers the checks and the version; an unreachable database is 503, named", async () => {
  const healthy = await call("/health");
  assert.equal(healthy.status, 200);
  const checks = { database: "ok", migrations: "ok", redis: "ok" };
  assert.deepEqual(healthy.body, { status: "ok", version: "0.0.0", checks });
  const live = await call("/health/live");
  assert.deepEqual([live.status, live.body], [200, { status: "ok" }]);

  const closedPort = new URL(databaseUrl("app"));
  closedPort.port = "1";
  const unreachable = createDbClient("app", { url: closedPort.toString() });
  const down = await start({
    port: 0,
    log,
    modules: [],
    migrations: { url: ownerUrl(db.schema) },
    clients: { app: unreachable, owner: asRole("owner") },
  });
  try {
    const failing = await call("/health", {}, down.url);
    assert.equal(failing.status, 503);
    assert.deepEqual(failing.body, {
      status: "failing",
      version: "0.0.0",
      checks: { database: "failing", migrations: "ok", redis: "ok" },
      failing: ["database"],
    });
  } finally {
    await down.close();
    await unreachable.$disconnect();
  }
});

test("a fixture migration that fails stops the start: its name is logged and nothing listens", async () => {
  const schema = `${db.schema.slice(0, 55)}_broken`;
  const owner = asRole("owner");
  const set = migrationSet("api-broken", [BROKEN]);
  const port = await freePort();
  await owner.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await owner.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  try {
    await assert.rejects(
      start({ port, log, modules: [], migrations: { url: ownerUrl(schema), config: set.config } }),
      (error: unknown) => isAppError(error) && error.code === "migration_failed",
    );
    const line = logs.lines().find((entry) => entry.migration === BROKEN);
    assert.equal(line?.level, "fatal", "no fatal line names the migration");
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health/live`), "something listens");
  } finally {
    rmSync(set.dir, { recursive: true, force: true });
    await owner.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
});

test("the fixture route: 401 with no session, 403 when the resolver refuses, the tenant inside", async () => {
  const anonymous = await call(fixturePath);
  assert.deepEqual([anonymous.status, anonymous.body], [401, { code: "auth_session_invalid" }]);
  const refused = await call("/v1/workspaces/wsp_fixture_b/fixture", { headers: { cookie } });
  assert.deepEqual([refused.status, refused.body], [403, { code: "forbidden" }]);
  const member = await call(fixturePath, { headers: { cookie } });
  assert.equal(member.status, 200);
  assert.deepEqual(member.body, { workspaceId: FIXTURE_WORKSPACE, setting: FIXTURE_WORKSPACE });
});

test("a body off the schema is 400 with the field paths; an AppError is its status and code only", async () => {
  const body = JSON.stringify({ name: 42, items: [{ qty: "body-value-x" }] });
  const headers = { cookie, "content-type": "application/json", "sec-fetch-site": "same-origin" };
  const invalid = await call(fixturePath, { method: "POST", headers, body });
  assert.equal(invalid.status, 400);
  const details = { fields: ["name", "items.0.qty"] };
  assert.deepEqual(invalid.body, { code: "validation_failed", details });
  const missing = await call(`${fixturePath}/missing`, { headers: { cookie } });
  assert.deepEqual([missing.status, missing.body], [404, { code: "fixture_not_found" }]);
});

test("the request log line: method, route, status, duration and workspace; no query, body or cookie", async () => {
  const answer = await call(`${fixturePath}?token=query-value-x`, { headers: { cookie } });
  assert.equal(answer.status, 200);
  assert.equal((await call("/nowhere")).status, 404);
  const line = logs.lines().find((entry) => entry.request_id === answer.requestId);
  const { method, route, status, workspace_id, duration_ms } = line ?? {};
  assert.deepEqual(
    { method, route, status, workspace_id },
    {
      method: "GET",
      route: "/v1/workspaces/:workspaceId/fixture",
      status: 200,
      workspace_id: FIXTURE_WORKSPACE,
    },
  );
  assert.equal(typeof duration_ms, "number");
  const text = logs.raw.join("");
  for (const leak of ["query-value-x", "body-value-x", cookie.split("=")[1] ?? cookie]) {
    assert.ok(!text.includes(leak), `a log line carries ${leak}`);
  }
  const own = JSON.parse(readFileSync(join(apiDir, "log-schema.json"), "utf8")) as LogSchema;
  const schema = {
    keys: [...logSchema.keys, ...own.keys],
    suffixes: [...logSchema.suffixes, ...own.suffixes],
  };
  assert.deepEqual(checkLogLines(logs.raw.join("").split("\n").filter(Boolean), schema), []);
});

test("pnpm modules:generate lists the module pnpm module:new made, with no edit to the host", () => {
  const repo = resolve(apiDir, "..", "..", "..");
  mkdirSync(join(apiDir, ".tmp"), { recursive: true });
  const copy = mkdtempSync(join(apiDir, ".tmp", "modules-"));
  try {
    cpSync(join(repo, "tools", "module-new.mjs"), join(copy, "tools", "module-new.mjs"));
    cpSync(join(repo, "core", "modules", "_template"), join(copy, "core", "modules", "_template"), {
      recursive: true,
    });
    const run = (...args: string[]) => spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(run(join(copy, "tools", "module-new.mjs"), "probe").status, 0);
    const out = join(copy, "modules.generated.ts");
    const generated = run(
      join(apiDir, "scripts", "modules-generate.ts"),
      join(copy, "core", "modules"),
      out,
    );
    assert.equal(generated.stdout, "modules: probe\n", generated.stderr);
    const source = readFileSync(out, "utf8");
    assert.match(
      source,
      /name: "probe", load: \(\) => load\(".*\/modules\/probe\/dist\/index\.js"\)/,
    );
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("a workspace route without @Permission is 500 permission_undeclared; a permission can() refuses is 403", async () => {
  const undeclared = await call(`/v1/workspaces/${FIXTURE_WORKSPACE}/guard/undeclared`, {
    headers: { cookie },
  });
  assert.deepEqual([undeclared.status, undeclared.body], [500, { code: "permission_undeclared" }]);
  // An account route's principal has no membership: can() refuses it before any role is read.
  const refused = await call("/v1/guard/declared", { headers: { cookie } });
  assert.deepEqual([refused.status, refused.body], [403, { code: "forbidden" }]);
});

test("a whytide:own-runs route has no run around it: the tenant on the request, its own withTenant", async () => {
  const res = await call(`/v1/workspaces/${FIXTURE_WORKSPACE}/guard/own-runs`, {
    headers: { cookie },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    outside: { tenant: "no_tenant_context", client: "no_tenant_context" },
    inside: { workspaceId: FIXTURE_WORKSPACE, setting: FIXTURE_WORKSPACE },
  });
});

test("a module's routes stay guarded: whytide:public is the host's; a controller outside the mounts stops the start", async () => {
  const open = await call("/v1/guard/open");
  assert.deepEqual([open.status, open.body], [401, { code: "auth_session_invalid" }]);
  const stray: ModuleLoader = { name: "stray", load: async () => ({ api: StrayApi }) };
  const clients = { app: asRole("app"), owner: asRole("owner") };
  const migrations = { url: ownerUrl(db.schema) };
  await assert.rejects(start({ port: 0, log, modules: [stray], migrations, clients }), (error) => {
    assert.ok(isAppError(error));
    const details = { field: "controllers", nestModule: "StrayModule" };
    assert.deepEqual([error.code, error.details], ["module_invalid", details]);
    return true;
  });
});

/** A port nothing listens on, from the system's pick. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  await new Promise((done) => server.close(done));
  assert.ok(address && typeof address === "object");
  return address.port;
}
