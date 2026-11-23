// Roles in can() end to end (gamma-p6-010; core/packages/platform/README.md "Principal and
// permissions"): the host started with identity, whose resolver reads the membership and its role on
// every request, the fixture module's routes without the fixture's own resolver, which answers Owner
// only, and contacts; on the fake authentication adapter, in a schema of the worktree's database,
// answering real HTTP. The fixture's POST declares fixture.write (Owner and Admin), its GETs
// fixture.read (every role). Memberships are tenancy's createMembership. It lives here: a module
// never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createLeadForPerson, upsertCompany, upsertPersonFromSource } from "@whytide/contacts";
import { useContactsClient, useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, servicePrincipal } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import {
  createMembership,
  createTwoWorkspaces,
  createUser,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import type { ModuleLoader } from "../src/modules.ts";
import { type Api, start } from "../src/start.ts";

const db = withTestDb({ fixtures: ["20261021000800_db_test_tenant_settings"] });
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
useContactsClient(app);
useHashSalt("test-salt-".repeat(4));
const fixture: ModuleLoader = {
  name: "fixture",
  load: async () => {
    const { workspaceResolver: _own, ...rest } = await import("./fixtures/module/index.ts");
    return rest;
  },
};
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      fixture,
      { name: "contacts", load: () => import("@whytide/contacts") },
    ],
    migrations: { url: migrations.toString() },
    clients: { app, owner: asRole("owner") },
  });
});
after(() => api?.close());

type Answer = { status: number; body: any };
/** A call from the app, as the user, to …/workspaces/<workspace>/<path>; a write carries a new key. */
async function call(user: string, workspace: string, method: string, path: string, body?: unknown) {
  const cookie = signInAs(user)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const headers: Record<string, string> = { cookie, "sec-fetch-site": "same-origin" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["idempotency-key"] = randomUUID();
  const url = new URL(`/v1/workspaces/${workspace}/${path}`, api.url);
  const json = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(url, { method, headers, body: json });
  const text = await res.text();
  const isJson = res.headers.get("content-type")?.startsWith("application/json");
  return { status: res.status, body: isJson ? JSON.parse(text) : text } as Answer;
}

const FORBIDDEN = { status: 403, body: { code: "forbidden" } };
const ITEMS = { name: "roles", items: [{ qty: 1 }, { qty: 2 }] };
const COUNTED = { status: 200, body: { items: 2 } };

test("a Member is 403 forbidden on the fixture's POST, fixture.write, and reads its GETs, fixture.read; an Owner does both; a member of another workspace is 403 on both", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId: ws, role: "Member" });
  const inside = { status: 200, body: { workspaceId: ws, setting: ws } };
  const greeted = { status: 200, body: { name: "ada", greeting: "hello" } };

  assert.deepEqual(await call(a.user.id, ws, "GET", "fixture"), inside);
  assert.deepEqual(await call(a.user.id, ws, "POST", "fixture", ITEMS), COUNTED);
  assert.deepEqual(await call(member.id, ws, "GET", "fixture"), inside);
  assert.deepEqual(await call(member.id, ws, "GET", "fixture/ada"), greeted);
  assert.deepEqual(await call(member.id, ws, "POST", "fixture", ITEMS), FORBIDDEN);
  assert.deepEqual(await call(b.user.id, ws, "GET", "fixture"), FORBIDDEN);
  assert.deepEqual(await call(b.user.id, ws, "POST", "fixture", ITEMS), FORBIDDEN);
  assert.deepEqual(await call(member.id, b.workspace.id, "GET", "fixture"), FORBIDDEN);
});

test("a membership changed from Owner to Member between two requests is refused the fixture's POST on the second: the role is read on every request", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const roleOf = (role: "Owner" | "Member") =>
    app.membership.update({ where: { id: a.membership.id }, data: { role } });
  assert.deepEqual(await call(a.user.id, ws, "POST", "fixture", ITEMS), COUNTED);
  await roleOf("Member");
  assert.deepEqual(await call(a.user.id, ws, "POST", "fixture", ITEMS), FORBIDDEN);
  assert.equal((await call(a.user.id, ws, "GET", "fixture")).status, 200);
  await roleOf("Owner");
  assert.deepEqual(await call(a.user.id, ws, "POST", "fixture", ITEMS), COUNTED);
});

test("contacts: a Member's export is 403 forbidden and an Owner's still answers the CSV; a Member still adds a person and a company to the never-contact list and records an opt-out", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId: ws, role: "Member" });
  const seeded = await withTenant(
    { workspaceId: ws, principal: servicePrincipal("roles_test") },
    async () => {
      const person = async (slug: string) => {
        const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Rae" };
        return (await upsertPersonFromSource({ source: "import", provider: "csv", profile }))
          .person;
      };
      const rae = await person("rae-roles");
      await createLeadForPerson({ personId: rae.id, source: { kind: "imported", ref: "imp_1" } });
      const kai = await person("kai-roles");
      const company = { name: "Harbor Labs", domain: "harbor-roles.example" };
      const harbor = (await upsertCompany({ source: "import", provider: "csv", company })).company;
      return { rae, kai, harbor };
    },
    { client: app },
  );

  const csv = "contacts/exports/leads.csv";
  assert.deepEqual(await call(member.id, ws, "GET", csv), FORBIDDEN);
  const owners = await call(a.user.id, ws, "GET", csv);
  assert.equal(owners.status, 200);
  assert.match(owners.body, /first_name,last_name,/);
  assert.match(owners.body, /https:\/\/linkedin\.com\/in\/rae-roles/);

  const add = (body: object) => call(member.id, ws, "POST", "contacts/suppression", body);
  const blocked = await add({ kind: "person", personId: seeded.rae.id });
  const company = await add({ kind: "company", companyId: seeded.harbor.id });
  const optOut = await add({ kind: "person", personId: seeded.kai.id, layer: "opt_out" });
  assert.deepEqual(
    [blocked, company, optOut].map(({ status, body }) => [status, body.layer, body.createdBy]),
    [
      [201, "blocklist", member.id],
      [201, "blocklist", member.id],
      [201, "opt_out", member.id],
    ],
  );
  assert.deepEqual(
    [blocked.body.personId, company.body.companyId, optOut.body.personId],
    [seeded.rae.id, seeded.harbor.id, seeded.kai.id],
  );
  const listed = await call(member.id, ws, "GET", "contacts/suppression");
  assert.equal(listed.body.entries.length, 3);
});

test("contacts: a Member excludes a competitor and a customer by their domains, and is 403 forbidden lifting one or removing a block, suppression.remove; an Owner lifts it", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId: ws, role: "Member" });
  const add = (user: string, body: object) => call(user, ws, "POST", "contacts/suppression", body);
  const competitor = { kind: "company", value: "rival-roles.example", relationship: "competitor" };
  const rival = await add(member.id, competitor);
  const customer = { kind: "company", value: "client-roles.example", relationship: "customer" };
  const client = await add(member.id, { ...customer, channel: "linkedin" });
  const block = await add(a.user.id, { kind: "company", value: "blocked-roles.example" });
  assert.deepEqual(
    [rival, client, block].map(({ status, body }) => [status, body.layer, body.relationship]),
    [
      [201, "relationship", "competitor"],
      [201, "relationship", "customer"],
      [201, "blocklist", null],
    ],
  );
  assert.deepEqual([rival.body.createdBy, client.body.channel], [member.id, "linkedin"]);

  const lift = (user: string, id: string) => call(user, ws, "DELETE", `contacts/suppression/${id}`);
  const listed = async () => {
    const { body } = await call(member.id, ws, "GET", "contacts/suppression");
    return body.entries.map(({ id }: { id: string }) => id).sort();
  };
  const all = [rival.body.id, client.body.id, block.body.id].sort();
  assert.deepEqual(await lift(member.id, rival.body.id), FORBIDDEN);
  assert.deepEqual(await lift(member.id, block.body.id), FORBIDDEN);
  assert.deepEqual(await listed(), all, "a refused removal leaves every entry in force");
  assert.equal((await lift(a.user.id, rival.body.id)).status, 204);
  assert.deepEqual(await listed(), [client.body.id, block.body.id].sort());
});
