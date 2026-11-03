// contacts' person routes end to end (alpha-p5-010; core/modules/contacts/README.md "Routes"): the host
// started with identity, whose resolver guards the workspace, and contacts, mounted under
// /v1/workspaces/:workspaceId/contacts, on the fake authentication adapter, in a schema of the
// worktree's database, answering real HTTP. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
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

const fetchedAt = new Date("2026-10-01T08:00:00Z");
/** A person of the tenant's workspace, written the way an import writes one. */
const seed = ({ workspace }: TestTenant, slug: string) =>
  withTenant(
    { workspaceId: workspace.id, principal: servicePrincipal("contacts_test") },
    async () => {
      const linkedinUrl = `https://linkedin.com/in/${slug}`;
      const profile = { linkedinUrl, firstName: "Elif", title: "Head of Data", fetchedAt };
      return (await upsertPersonFromSource({ source: "import", provider: "csv", profile })).person;
    },
    { client: asRole("app") },
  );

/** GET …/contacts/<path> of the workspace, signed in as the user when one is given. */
async function get(workspaceId: string, path: string, userId?: string) {
  const session = userId === undefined ? [] : signInAs(userId);
  const cookie = session.map(({ name, value }) => `${name}=${value}`).join("; ");
  const url = new URL(`/v1/workspaces/${workspaceId}/contacts/${path}`, api.url);
  const res = await fetch(url, { headers: cookie ? { cookie } : {} });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const ids = (body: Record<string, unknown>) =>
  (body.persons as { id: string }[]).map((person) => person.id);

test("GET …/contacts/persons pages the workspace's people by cursor; …/persons/{id} answers one with its provenance; nothing of another workspace", async () => {
  const [a, b] = await createTwoWorkspaces();
  const [first, second, third] = [
    await seed(a, "elif-1"),
    await seed(a, "elif-2"),
    await seed(a, "elif-3"),
  ];
  const theirs = await seed(b, "elif-1");
  const newest = [first, second, third]
    .map((person) => person.id)
    .sort()
    .reverse();

  const page = await get(a.workspace.id, "persons?limit=2", a.user.id);
  assert.deepEqual([page.status, ids(page.body)], [200, newest.slice(0, 2)]);
  assert.equal(page.body.nextCursor, newest[1]);
  const last = await get(a.workspace.id, `persons?limit=2&cursor=${newest[1]}`, a.user.id);
  assert.deepEqual([ids(last.body), last.body.nextCursor], [newest.slice(2), null]);

  const stamp = { source: "import", provider: "csv", at: fetchedAt.toISOString() };
  const one = await get(a.workspace.id, `persons/${first.id}`, a.user.id);
  assert.deepEqual(one, {
    status: 200,
    body: {
      id: first.id,
      linkedinUrl: "https://linkedin.com/in/elif-1",
      firstName: "Elif",
      lastName: null,
      headline: null,
      title: "Head of Data",
      companyName: null,
      companyId: null,
      locationText: null,
      locationCountry: null,
      provenance: { linkedinUrl: stamp, firstName: stamp, title: stamp },
      createdAt: first.createdAt.toISOString(),
      updatedAt: first.updatedAt.toISOString(),
    },
  });
  const notFound = { status: 404, body: { code: "person_not_found" } };
  assert.deepEqual(await get(a.workspace.id, `persons/${theirs.id}`, a.user.id), notFound);
  assert.deepEqual(await get(b.workspace.id, "persons", a.user.id), {
    status: 403,
    body: { code: "forbidden" },
  });
  assert.equal((await get(a.workspace.id, "persons")).status, 401);
  assert.equal((await get(a.workspace.id, "persons?limit=101", a.user.id)).status, 400);
});
