// qualification's re-score route end to end (alpha-p6-040; core/modules/qualification/README.md "The
// re-score"): the host started with identity and qualification, on the fake authentication adapter,
// in a schema of the worktree's database, answering real HTTP. The request is read from the outbox;
// the run the worker starts from it is the worker's test (core/apps/worker/tests/
// qualification-batch.test.ts). It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { collectLogs, createLogger } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import { createTwoWorkspaces, type TestTenant, useTenancyClient } from "@whytide/tenancy/testing";
import type { ModuleLoader } from "../src/modules.ts";
import type { Api } from "../src/start.ts";

const APP_ORIGIN = "https://app.whytide.test";
// The host reads it as its config loads: set before anything of the host is imported.
process.env.APP_PUBLIC_ORIGIN = APP_ORIGIN;
const { start } = await import("../src/start.ts");

// qualification by its build's path, as src/modules.generated.ts loads it.
const qualification = new URL("../../../../modules/qualification/dist/index.js", import.meta.url);
const db = withTestDb();
useTenancyClient(asRole("app"));
const modules: ModuleLoader[] = [
  { name: "identity", load: () => import("@whytide/identity") },
  { name: "qualification", load: () => import(qualification.href) },
];
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules,
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

/** POST …/qualification/rescore of `workspaceId` as the tenant's Owner under the Idempotency-Key `key`. */
async function rescore(who: TestTenant, workspaceId: string, body: object, key = randomUUID()) {
  const url = new URL(`/v1/workspaces/${workspaceId}/qualification/rescore`, api.url);
  const cookie = signInAs(who.user.id)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const json = { origin: APP_ORIGIN, "content-type": "application/json", "idempotency-key": key };
  const res = await fetch(url, {
    method: "POST",
    headers: { cookie, ...json },
    body: JSON.stringify(body),
  });
  const answer = (await res.json()) as Record<string, unknown>;
  return { status: res.status, replayed: res.headers.get("idempotent-replayed"), body: answer };
}

test("POST …/qualification/rescore with personIds answers 202 with the leads it marked, none for persons without a lead, and writes one qualification.rescore_requested, its key answered again without a second; an empty list answers 400, another workspace 403", async () => {
  const [a, b] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const key = randomUUID();
  const personIds = ["per_1", "per_2"];
  const first = await rescore(a, workspaceId, { personIds }, key);
  assert.deepEqual([first.status, first.replayed], [202, null]);
  assert.match(String(first.body.requestId), /^rsq_/);
  assert.equal(first.body.marked, 0);
  assert.deepEqual(await rescore(a, workspaceId, { personIds }, key), {
    ...first,
    replayed: "true",
  });
  const where = { workspaceId, eventName: "qualification.rescore_requested" };
  const outbox = await asRole("app").outboxEntry.findMany({ where });
  const requestId = first.body.requestId;
  assert.deepEqual(
    outbox.map((row) => row.payload),
    [{ workspaceId, requestId, personIds }],
  );

  assert.equal((await rescore(a, workspaceId, { personIds: [] })).status, 400);
  assert.equal((await rescore(b, workspaceId, {})).status, 403);
});
