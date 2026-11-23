// tenancy's members routes end to end (gamma-p6-030; core/modules/tenancy/README.md "Members"): the
// host started with tenancy, whose `api` it mounts under /v1/workspaces/:workspaceId/tenancy beside
// GET /v1/me, and identity, whose resolver reads the membership and its role on every request and
// whose hooks decide who may sign in; on the fake authentication adapter, in a schema of the
// worktree's database, answering real HTTP. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { authHooks, createInvite } from "@whytide/identity";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import {
  createMembership,
  createTwoWorkspaces,
  createUser,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import { type Api, start } from "../src/start.ts";

const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "tenancy", load: () => import("@whytide/tenancy") },
      { name: "identity", load: () => import("@whytide/identity") },
    ],
    migrations: { url: migrations.toString() },
    clients: { app, owner: asRole("owner") },
  });
});
after(() => api?.close());

type Answer = { status: number; body: any };
const cookieOf = (user: string) =>
  signInAs(user)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
/** A call from the app, as the user, to …/workspaces/<workspace>/tenancy/<path>. */
async function call(user: string, workspace: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {
    cookie: cookieOf(user),
    "sec-fetch-site": "same-origin",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["idempotency-key"] = randomUUID();
  const url = new URL(`/v1/workspaces/${workspace}/tenancy/${path}`, api.url);
  const json = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(url, { method, headers, body: json });
  const text = await res.text();
  const isJson = res.headers.get("content-type")?.startsWith("application/json");
  return { status: res.status, body: isJson ? JSON.parse(text) : text } as Answer;
}
/** GET /v1/me's memberships, as the user: the workspace ids and roles. */
async function memberships(user: string): Promise<[string, string][]> {
  const res = await fetch(new URL("/v1/me", api.url), { headers: { cookie: cookieOf(user) } });
  const body = (await res.json()) as { memberships: { workspaceId: string; role: string }[] };
  return body.memberships.map(({ workspaceId, role }) => [workspaceId, role]);
}
const owners = async (workspaceId: string) =>
  app.membership.findMany({
    where: { workspaceId, role: "Owner", removedAt: null },
    select: { id: true },
  });

const FORBIDDEN = { status: 403, body: { code: "forbidden" } };
const NOT_FOUND = { status: 404, body: { code: "membership_not_found" } };
const SELF = { status: 409, body: { code: "member_is_self" } };
const TO_MEMBER = { role: "Member" };

test("roles: a Member reads the list, its own row isSelf, and is 403 on PATCH and DELETE; a member of another workspace is 403 on all three", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const kai = await createUser();
  const kais = await createMembership({ userId: kai.id, workspaceId: ws, role: "Member" });

  const listed = await call(kai.id, ws, "GET", "members");
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.members.map((m: any) => [m.membershipId, m.role, m.isSelf]),
    [
      [a.membership.id, "Owner", false],
      [kais.id, "Member", true],
    ],
  );
  assert.deepEqual(listed.body.members[1], {
    membershipId: kais.id,
    userId: kai.id,
    email: kai.email,
    displayName: kai.displayName,
    role: "Member",
    joinedAt: kais.createdAt.toISOString(),
    isSelf: true,
  });
  const owner = `members/${a.membership.id}`;
  assert.deepEqual(await call(kai.id, ws, "PATCH", owner, TO_MEMBER), FORBIDDEN);
  assert.deepEqual(await call(kai.id, ws, "DELETE", owner), FORBIDDEN);
  assert.deepEqual(await call(b.user.id, ws, "GET", "members"), FORBIDDEN);
  assert.deepEqual(await call(b.user.id, ws, "PATCH", `members/${kais.id}`, TO_MEMBER), FORBIDDEN);
  assert.deepEqual(await call(b.user.id, ws, "DELETE", `members/${kais.id}`), FORBIDDEN);
  assert.equal((await call(a.user.id, ws, "GET", "members")).body.members[0].isSelf, true);
});

test("an Owner changes a Member to Owner and back; the member's next request carries the new role", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const kai = await createUser();
  const kais = await createMembership({ userId: kai.id, workspaceId: ws, role: "Member" });
  const other = await createUser();
  const others = `members/${(await createMembership({ userId: other.id, workspaceId: ws, role: "Member" })).id}`;
  assert.deepEqual(await call(kai.id, ws, "PATCH", others, TO_MEMBER), FORBIDDEN);

  const promoted = await call(a.user.id, ws, "PATCH", `members/${kais.id}`, { role: "Owner" });
  const { membershipId, role, isSelf } = promoted.body;
  assert.deepEqual([promoted.status, membershipId, role, isSelf], [200, kais.id, "Owner", false]);
  assert.equal((await call(kai.id, ws, "PATCH", others, TO_MEMBER)).status, 200);
  assert.deepEqual(await memberships(kai.id), [[ws, "Owner"]]);

  const back = await call(a.user.id, ws, "PATCH", `members/${kais.id}`, TO_MEMBER);
  assert.deepEqual([back.status, back.body.role], [200, "Member"]);
  assert.deepEqual(await call(kai.id, ws, "PATCH", others, TO_MEMBER), FORBIDDEN);
  assert.deepEqual(await memberships(kai.id), [[ws, "Member"]]);
});

test("Admin is refused naming role; an unknown, another workspace's or a removed membership is membership_not_found; the caller's own row is member_is_self; DELETE again is 204 with one event", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const kai = await createUser();
  const kais = `members/${(await createMembership({ userId: kai.id, workspaceId: ws, role: "Member" })).id}`;
  const as = (method: string, path: string, body?: unknown) =>
    call(a.user.id, ws, method, path, body);

  const admin = { status: 400, body: { code: "validation_failed", details: { fields: ["role"] } } };
  assert.deepEqual(await as("PATCH", kais, { role: "Admin" }), admin);
  assert.equal((await as("PATCH", kais, { role: "Owner", note: "strict" })).status, 400);
  for (const path of ["members/mem_missing", `members/${b.membership.id}`]) {
    assert.deepEqual(await as("PATCH", path, TO_MEMBER), NOT_FOUND, path);
    assert.deepEqual(await as("DELETE", path), NOT_FOUND, path);
  }
  assert.deepEqual(await as("PATCH", `members/${a.membership.id}`, TO_MEMBER), SELF);
  assert.deepEqual(await as("DELETE", `members/${a.membership.id}`), SELF);

  assert.deepEqual(await as("DELETE", kais), { status: 204, body: "" });
  assert.deepEqual(await as("DELETE", kais), { status: 204, body: "" });
  assert.deepEqual(await as("PATCH", kais, { role: "Owner" }), NOT_FOUND);
  const events = await app.outboxEntry.findMany({ where: { eventName: "tenancy.member_removed" } });
  const ids = { workspaceId: ws, membershipId: kais.slice("members/".length), userId: kai.id };
  assert.deepEqual(
    events.map(({ payload }) => payload),
    [ids],
  );
});

test("two Owners demoting each other at the same time leave exactly one Owner", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const ben = await createUser();
  const bens = await createMembership({ userId: ben.id, workspaceId: ws, role: "Owner" });
  const answers = await Promise.all([
    call(a.user.id, ws, "PATCH", `members/${bens.id}`, TO_MEMBER),
    call(ben.id, ws, "PATCH", `members/${a.membership.id}`, TO_MEMBER),
  ]);
  // The second waited on the first's lock (last_owner), or came after its commit as a Member (403).
  const codes = answers.map(({ status, body }) => (status === 200 ? "changed" : body.code)).sort();
  assert.equal(codes.filter((code) => code === "changed").length, 1, String(codes));
  assert.ok(["forbidden", "last_owner"].includes(codes[1] ?? ""), String(codes));
  assert.equal((await owners(ws)).length, 1);
});

test("a removed member is refused from their next request and GET /v1/me drops the workspace; their other workspace answers; with no membership left they may not sign in until invited again", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const kai = await createUser();
  const kais = await createMembership({ userId: kai.id, workspaceId: ws, role: "Member" });
  await createMembership({ userId: kai.id, workspaceId: b.workspace.id, role: "Member" });
  assert.equal((await call(kai.id, ws, "GET", "members")).status, 200);

  assert.equal((await call(a.user.id, ws, "DELETE", `members/${kais.id}`)).status, 204);
  assert.deepEqual(await call(kai.id, ws, "GET", "members"), FORBIDDEN);
  assert.deepEqual(await call(kai.id, a.workspace.slug, "GET", "members"), FORBIDDEN);
  assert.equal((await call(kai.id, b.workspace.id, "GET", "members")).status, 200);
  assert.deepEqual(await memberships(kai.id), [[b.workspace.id, "Member"]]);
  const listed = (await call(a.user.id, ws, "GET", "members")).body.members;
  assert.ok(!listed.some((m: any) => m.userId === kai.id), "the list drops a removed member");

  const solo = await createUser();
  const solos = await createMembership({ userId: solo.id, workspaceId: ws, role: "Member" });
  assert.equal(await authHooks.allowSignIn(solo.email), true);
  assert.equal((await call(a.user.id, ws, "DELETE", `members/${solos.id}`)).status, 204);
  assert.equal(await authHooks.allowSignIn(solo.email), false, "no membership, no invite");
  await createInvite({ workspaceId: ws, email: solo.email, role: "Owner", invitedBy: null });
  assert.equal(await authHooks.allowSignIn(solo.email), true, "invited again");
  // The link followed: identity accepts the invite through addMember, with the invite's role.
  await authHooks.users.findOrCreateByEmail(solo.email);
  assert.deepEqual(await memberships(solo.id), [[ws, "Owner"]]);
  assert.equal((await call(solo.id, ws, "GET", "members")).status, 200);
});
