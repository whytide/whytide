// credits' routes end to end (alpha-p3-060; core/modules/credits/README.md "Public interface"): the
// host started with identity, whose resolver checks the membership, and credits without its onStart
// (its seeder writes the public schema): the balance of the workspace's organization, by id or slug,
// another organization's own, the usage list a page at a time, and credits.read required. On the fake
// authentication adapter, in a schema of the worktree's database. It lives here: a module never
// imports a host.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, newId } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import {
  createTwoWorkspaces,
  createUser,
  type TestTenant,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import { type Api, start } from "../src/start.ts";

// credits by its build's path, as src/modules.generated.ts loads it: the api lists no module with a
// screen (core/apps/web/docs/screens.md).
const build = new URL("../../../../modules/credits/dist/", import.meta.url);
type Credits = typeof import("../../../modules/credits/dist/index.js");
type CreditsTesting = typeof import("../../../modules/credits/dist/testing/index.js");
const credits: Credits = await import(new URL("index.js", build).href);
const { grantAllowance }: CreditsTesting = await import(new URL("testing/index.js", build).href);

const db = withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  const { onStart: _seeder, ...withoutSeeder } = credits;
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "credits", load: async () => withoutSeeder },
    ],
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

/** GET /v1/workspaces/<workspace>/credits/<path>, signed in as the user. */
async function get(userId: string, workspace: string, path: string) {
  const cookie = signInAs(userId).map(({ name, value }) => `${name}=${value}`);
  const url = new URL(`/v1/workspaces/${workspace}/credits/${path}`, api.url);
  const res = await fetch(url, { headers: { cookie: cookie.join("; ") } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A usage row of the workspace, as reserve writes one. */
const usage = ({ workspace }: TestTenant, credits: number, createdAt: Date) =>
  asRole("app").creditUsage.create({
    data: {
      id: newId("usage"),
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      action: "test.read",
      quantity: 1,
      credits,
      idempotencyKey: `key-${createdAt.getTime()}`,
      leaseExpiresAt: new Date(createdAt.getTime() + 15 * 60_000),
      subjectRef: "lead_test",
      createdAt,
    },
  });

test("GET …/credits/balance: the numbers of the workspace's organization, by id or slug; another organization sees its own", async () => {
  const [a, b] = await createTwoWorkspaces();
  await grantAllowance([a.organization.id, b.organization.id], 100);
  await usage(a, 30, new Date());
  const periodEnd = credits.periodFor(new Date()).end.toISOString();
  const own = { available: "70", granted: "100", reserved: "30", committed: "0", periodEnd };
  for (const named of [a.workspace.id, a.workspace.slug]) {
    assert.deepEqual(await get(a.user.id, named, "balance"), { status: 200, body: own });
  }
  const other = { available: "100", granted: "100", reserved: "0", committed: "0", periodEnd };
  assert.deepEqual(await get(b.user.id, b.workspace.id, "balance"), { status: 200, body: other });
});

test("GET …/credits/usage: the workspace's rows, newest first, a page at a time", async () => {
  const [a, b] = await createTwoWorkspaces();
  const older = await usage(a, 1, new Date(Date.now() - 60_000));
  const newer = await usage(a, 2, new Date());
  await usage(b, 3, new Date());
  const first = await get(a.user.id, a.workspace.id, "usage?limit=1");
  const items = first.body.items as { id: string; credits: string }[];
  assert.deepEqual([first.status, items.map((i) => [i.id, i.credits])], [200, [[newer.id, "2"]]]);
  const next = await get(
    a.user.id,
    a.workspace.id,
    `usage?limit=1&cursor=${first.body.nextCursor}`,
  );
  const rest = next.body.items as { id: string }[];
  assert.deepEqual([rest.map((i) => i.id), next.body.nextCursor], [[older.id], null]);
});

test("credits.read is required: a principal without a membership in the workspace gets 403", async () => {
  const [a] = await createTwoWorkspaces();
  const nobody = await createUser();
  const forbidden = { status: 403, body: { code: "forbidden" } };
  assert.deepEqual(await get(nobody.id, a.workspace.id, "balance"), forbidden);
  assert.deepEqual(await get(nobody.id, a.workspace.id, "usage"), forbidden);
});
