// The lead list of one source end to end (csv-import-sources; core/modules/contacts/README.md
// "Routes"): `source`, a source's ref, on GET …/contacts/leads, …/leads/counts,
// …/leads/{personId}/neighbours and the leads CSV, with another filter and a sort, across a cursor,
// against another workspace's ref, and a ref off its shape. The host started with identity and
// contacts on the fake authentication adapter, in a schema of the worktree's database, answering
// real HTTP. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { applyQualification, createLeadForPerson, upsertPersonFromSource } from "@whytide/contacts";
import { useContactsClient, useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, servicePrincipal } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import { createTwoWorkspaces, type TestTenant, useTenancyClient } from "@whytide/tenancy/testing";
import { type Api, start } from "../src/start.ts";

const db = withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
useContactsClient(asRole("app"));
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
      { name: "contacts", load: () => import("@whytide/contacts") },
    ],
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

const JOB = "job_01K8E2E0000000000000000001";
const OTHER_JOB = "job_01K8E2E0000000000000000002";
const POST = "src_01K8E2E0000000000000000001";
type Source = { kind: "imported" | "signal"; ref: string; label?: string };
type Decision = Omit<Parameters<typeof applyQualification>[0], "personId">;

/** A person of the tenant's workspace and its lead, from these sources in order, then decided. */
const seed = ({ workspace }: TestTenant, slug: string, sources: Source[], decision?: Decision) =>
  withTenant(
    { workspaceId: workspace.id, principal: servicePrincipal("contacts_test") },
    async () => {
      const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: slug };
      const { person } = await upsertPersonFromSource({
        source: "import",
        provider: "csv",
        profile,
      });
      for (const source of sources) await createLeadForPerson({ personId: person.id, source });
      if (decision) await applyQualification({ personId: person.id, ...decision });
      return person.id;
    },
    { client: asRole("app") },
  );
const qualified = (fitScore: number, tier: "hot" | "warm" | "cool" = "hot"): Decision => ({
  status: "qualified",
  fitScore,
  confidence: "high",
  tier,
});

/** GET …/contacts/<path> of the workspace, signed in as the user: the status and the answer. */
async function get(workspaceId: string, path: string, userId: string) {
  const cookie = signInAs(userId)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const url = new URL(`/v1/workspaces/${workspaceId}/contacts/${path}`, api.url);
  const res = await fetch(url, { headers: { cookie } });
  const text = await res.text();
  const json = res.headers.get("content-type")?.startsWith("application/json");
  return {
    status: res.status,
    body: (json ? JSON.parse(text) : {}) as Record<string, unknown>,
    text,
  };
}
const ids = (body: Record<string, unknown>) =>
  (body.leads as { personId: string }[]).map((lead) => lead.personId);

/** Workspace A: two leads of the import, one of the post and the import, one of the post alone. */
async function leadsOfA(a: TestTenant) {
  const imported: Source = { kind: "imported", ref: JOB, label: "march.csv" };
  const post: Source = { kind: "signal", ref: POST, label: "Launch post" };
  return {
    hot: await seed(a, "ada-hot", [imported], qualified(90)),
    warm: await seed(a, "ada-warm", [imported, post], qualified(70, "warm")),
    pending: await seed(a, "ada-pending", [imported]),
    postOnly: await seed(a, "ada-post", [post], qualified(80)),
    other: await seed(a, "ada-other", [{ kind: "imported", ref: OTHER_JOB }], qualified(95)),
  };
}

test("source keeps the leads of that ref, any kind, on the list, its counts, the neighbours and the CSV; with a filter and a sort", async () => {
  const [a] = await createTwoWorkspaces();
  const { hot, warm, pending, postOnly } = await leadsOfA(a);
  const user = a.user.id;
  const ws = a.workspace.id;

  const all = await get(ws, `leads?source=${JOB}`, user);
  assert.deepEqual([all.status, ids(all.body)], [200, [hot, warm, pending]], "no score last");
  const ofPost = await get(ws, `leads?source=${POST}`, user);
  assert.deepEqual(ids(ofPost.body), [postOnly, warm], "a signal source's ref too");
  const filtered = await get(ws, `leads?source=${JOB}&status=qualified&tier=warm`, user);
  assert.deepEqual(ids(filtered.body), [warm]);
  const newest = await get(ws, `leads?source=${JOB}&sort=newest`, user);
  assert.deepEqual(ids(newest.body), [pending, warm, hot]);

  const counts = await get(ws, `leads/counts?source=${JOB}`, user);
  assert.deepEqual(counts.body.counts, {
    pending: 1,
    hard_filtered: 0,
    qualified: 2,
    not_qualified: 0,
    needs_review: 0,
    ai_failed: 0,
  });
  const every = await get(ws, "leads/counts", user);
  assert.equal((every.body.counts as Record<string, number>).qualified, 4, "every lead without it");

  // In the source's view the import's hot lead is followed by its warm one, not the post's 80.
  const near = await get(ws, `leads/${hot}/neighbours?source=${JOB}&status=qualified`, user);
  assert.deepEqual(near.body, { previous: null, next: warm });
  const unfiltered = await get(ws, `leads/${hot}/neighbours?status=qualified`, user);
  assert.deepEqual(unfiltered.body.next, postOnly);

  const csv = await get(ws, `exports/leads.csv?source=${JOB}&status=qualified`, user);
  assert.equal(csv.status, 200);
  const names = csv.text
    .trim()
    .split("\r\n")
    .slice(1)
    .map((line) => line.split(",")[0]);
  assert.deepEqual(names, ["ada-hot", "ada-warm"]);
});

test("source holds across the cursor, a ref of another workspace lists nothing, and a ref off its shape is validation_failed", async () => {
  const [a, b] = await createTwoWorkspaces();
  const { hot, warm, pending } = await leadsOfA(a);
  const THEIRS = "job_01K8E2E0000000000000000009";
  const theirs = await seed(b, "bo-hot", [{ kind: "imported", ref: THEIRS }], qualified(99));
  const user = a.user.id;
  const ws = a.workspace.id;

  const first = await get(ws, `leads?source=${JOB}&limit=2`, user);
  assert.deepEqual(ids(first.body), [hot, warm]);
  const cursor = encodeURIComponent(first.body.nextCursor as string);
  const second = await get(ws, `leads?source=${JOB}&limit=2&cursor=${cursor}`, user);
  assert.deepEqual([ids(second.body), second.body.nextCursor], [[pending], null]);

  // B's job in A: no lead, none counted; B's own list holds its lead.
  const crossed = await get(ws, `leads?source=${THEIRS}`, user);
  assert.deepEqual([crossed.status, ids(crossed.body)], [200, []]);
  const crossedCounts = await get(ws, `leads/counts?source=${THEIRS}`, user);
  const zero = Object.values(crossedCounts.body.counts as Record<string, number>);
  assert.deepEqual(zero, [0, 0, 0, 0, 0, 0]);
  const ofB = await get(b.workspace.id, `leads?source=${THEIRS}`, b.user.id);
  assert.deepEqual(ids(ofB.body), [theirs]);

  for (const path of [
    `leads?source=${encodeURIComponent('job"}]')}`,
    "leads/counts?source=a-b",
    `leads/${hot}/neighbours?source=${"x".repeat(65)}`,
    "exports/leads.csv?source=a%20b",
  ]) {
    const refused = await get(ws, path, user);
    assert.deepEqual([refused.status, refused.body.code], [400, "validation_failed"], path);
  }
});
