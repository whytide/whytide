// identity's guard and first sign-in end to end (alpha-p3-030): the host started with the identity
// module, whose exports fill its resolver slot and the authentication port's hooks, and the fixture
// module's route, without the fixture's own resolver; on the fake authentication adapter, in a schema
// of the worktree's database, answering real HTTP. An email signs in through the fake's test route,
// which asks the hooks as following a link does. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { after, before, test } from "node:test";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { createInvite } from "@whytide/identity";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import { createTwoWorkspaces, createUser, useTenancyClient } from "@whytide/tenancy/testing";
import type { ModuleLoader } from "../src/modules.ts";
import { WINDOW_MS } from "../src/protection/rate-limit.ts";
import { type Api, start } from "../src/start.ts";

const db = withTestDb({ fixtures: ["20261021000800_db_test_tenant_settings"] });
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
const identity: ModuleLoader = { name: "identity", load: () => import("@whytide/identity") };
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
  // The sign-in route's rate limit counts per address and minute: a minute no other run used.
  const minute = (Math.floor(Date.now() / WINDOW_MS) + randomInt(1_000, 1_000_000)) * WINDOW_MS;
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [identity, fixture],
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
    now: () => minute,
  });
});
after(() => api?.close());

/** Signs the email in as following a link does: the session cookie, or the refusal. */
async function signIn(email: string) {
  const res = await fetch(new URL("/api/auth/fake/sign-in", api.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  return { status: res.status, cookie, body: res.status === 204 ? undefined : await res.json() };
}

/** The fixture route of the workspace the URL names, by id or slug. */
async function fixtureOf(workspace: string, cookie: string) {
  const res = await fetch(new URL(`/v1/workspaces/${workspace}/fixture`, api.url), {
    headers: { cookie },
  });
  return { status: res.status, body: (await res.json()) as unknown };
}

test("the first sign-in of an invited email accepts the invite with an Owner membership; a second creates nothing", async () => {
  const app = asRole("app");
  const [a] = await createTwoWorkspaces();
  const invite = { email: "new@example.test", role: "Owner", invitedBy: null } as const;
  await createInvite({ workspaceId: a.workspace.id, ...invite });
  assert.equal((await signIn("New@Example.test")).status, 204);
  const user = await app.user.findUniqueOrThrow({ where: { email: "new@example.test" } });
  const memberships = await app.membership.findMany({ where: { userId: user.id } });
  assert.deepEqual(
    memberships.map(({ workspaceId, role }) => [workspaceId, role]),
    [[a.workspace.id, "Owner"]],
  );
  const invites = await app.invite.findMany();
  assert.ok(
    invites.length === 1 && invites[0]?.acceptedAt instanceof Date,
    "the invite is accepted",
  );
  const counts = async () => [await app.user.count(), await app.membership.count()];
  const made = await counts();
  assert.equal((await signIn("new@example.test")).status, 204);
  assert.deepEqual(await counts(), made);
  const stranger = await signIn("stranger@example.test");
  assert.deepEqual([stranger.status, stranger.body], [403, { code: "auth_invite_required" }]);
  assert.deepEqual(await counts(), made);
});

test("a member reaches the workspace route by id and by slug, in its tenant context; anyone else is 403", async () => {
  const [a, b] = await createTwoWorkspaces();
  const { cookie } = await signIn(a.user.email);
  for (const named of [a.workspace.id, a.workspace.slug]) {
    const inside = { workspaceId: a.workspace.id, setting: a.workspace.id };
    assert.deepEqual(await fixtureOf(named, cookie), { status: 200, body: inside });
  }
  const forbidden = { status: 403, body: { code: "forbidden" } };
  assert.deepEqual(await fixtureOf(b.workspace.id, cookie), forbidden);
  assert.deepEqual(await fixtureOf(b.workspace.slug, cookie), forbidden);
  const nobody = signInAs((await createUser()).id)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  assert.deepEqual(await fixtureOf(a.workspace.id, nobody), forbidden);
});
