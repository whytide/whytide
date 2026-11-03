// discovery's run route end to end (alpha-p5-040, alpha-p10-120; core/modules/discovery/README.md
// "POST …/imports/{job}/run"): the host started with the identity and discovery modules, on the fake
// authentication adapter, in a schema of the worktree's database, the files port on the slice's
// MinIO, contacts' hashes on a fixed test salt, answering real HTTP. The route claims the job and
// writes the event the worker starts the run from; the run itself is the worker's
// (core/apps/worker/tests/discovery-import.test.ts). It lives here: a module never imports a host.
// Made-up profile URLs only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import { createTwoWorkspaces, type TestTenant, useTenancyClient } from "@whytide/tenancy/testing";
import { type Api, start } from "../src/start.ts";

// discovery by its build's path, as src/modules.generated.ts loads it: the api does not list a
// module with a screen (core/apps/web/docs/screens.md).
const build = new URL("../../../../modules/discovery/dist/", import.meta.url);
type DiscoveryTesting = typeof import("../../../modules/discovery/dist/testing/index.js");
const testing: DiscoveryTesting = await import(new URL("testing/index.js", build).href);

const db = withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
testing.useDiscoveryClient(asRole("app"));
useHashSalt("test-salt-".repeat(4));
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "discovery", load: () => import(new URL("index.js", build).href) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

type Answer = { status: number; body: any };

/** A call to …/discovery/imports<path> in the tenant's workspace, as its Owner, from the app. */
async function call(tenant: TestTenant, method: string, path = "", body?: FormData) {
  const cookie = signInAs(tenant.user.id)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const url = new URL(`/v1/workspaces/${tenant.workspace.id}/discovery/imports${path}`, api.url);
  const res = await fetch(url, {
    method,
    headers: { cookie, "sec-fetch-site": "same-origin" },
    body,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined } as Answer;
}

/** Uploads a CSV of `lines` after the header; the job's id. */
async function upload(tenant: TestTenant, ...lines: string[]): Promise<string> {
  const form = new FormData();
  const file = ["linkedin_url,name\n", ...lines].join("");
  form.append("file", new Blob([file], { type: "text/csv" }), "people.csv");
  const created = await call(tenant, "POST", "", form);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.id;
}

const run = (tenant: TestTenant, id: string) => call(tenant, "POST", `/${id}/run`);
const profile = (n: number) => `https://www.linkedin.com/in/example-person-${n},Example Person\n`;
const requested = () =>
  asRole("app").outboxEntry.findMany({ where: { eventName: "discovery.import_run_requested" } });

test("a run answers 202 with the job running from now and one discovery.import_run_requested; again, import_not_runnable; another workspace's, import_not_found", async () => {
  const [a, b] = await createTwoWorkspaces();
  const id = await upload(a, profile(1), profile(2));
  assert.deepEqual(await run(b, id), { status: 404, body: { code: "import_not_found" } });
  const before = Date.now();
  const ran = await run(a, id);
  assert.equal(ran.status, 202, JSON.stringify(ran.body));
  const zero = { created: 0, updated: 0, skippedDuplicate: 0, skippedErased: 0, errors: 0 };
  const { status, counts, failure, createdBy, finishedAt } = ran.body;
  assert.deepEqual(
    { status, counts, failure, createdBy, finishedAt },
    { status: "running", counts: zero, failure: null, createdBy: a.user.id, finishedAt: null },
  );
  const startedAt = Date.parse(ran.body.startedAt);
  assert.ok(startedAt >= before - 1_000 && startedAt <= Date.now() + 1_000);
  assert.deepEqual(await call(a, "GET", `/${id}`), { status: 200, body: ran.body });
  assert.deepEqual(
    (await requested()).map((event) => event.payload),
    [{ workspaceId: a.workspace.id, jobId: id }],
  );
  assert.deepEqual(await run(a, id), { status: 409, body: { code: "import_not_runnable" } });
  const invalid = await upload(a, "not-a-profile-url,Example Person\n");
  assert.deepEqual(await run(a, invalid), { status: 409, body: { code: "import_not_runnable" } });
  assert.equal((await requested()).length, 1);
});

test("a failure before the claim commits leaves the job validated: its event refused, the claim rolls back with it", async () => {
  const [a] = await createTwoWorkspaces();
  const id = await upload(a, profile(1));
  // The test schema's outbox refuses the app role's insert, as a lost write would.
  await asRole("owner").$executeRawUnsafe("REVOKE INSERT ON outbox FROM app");
  try {
    assert.equal((await run(a, id)).status, 500);
  } finally {
    await asRole("owner").$executeRawUnsafe("GRANT INSERT ON outbox TO app");
  }
  const job = await call(a, "GET", `/${id}`);
  assert.deepEqual(
    [job.body.status, job.body.startedAt, job.body.counts],
    ["validated", null, null],
  );
  assert.deepEqual(await requested(), []);
  assert.equal((await run(a, id)).status, 202);
});
