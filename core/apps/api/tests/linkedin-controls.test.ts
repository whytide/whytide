// linkedin's kill switches through the routes (beta-p1-040; core/modules/linkedin/README.md "API"):
// the host started with identity and linkedin on the fake authentication adapter, in a schema of the
// worktree's database, answering real HTTP. GET and PUT …/linkedin/controls, POST …/accounts/{id}/pause
// and …/unpause: who may do what, the codes, a double press under one Idempotency-Key, the account's
// `paused` and `pausedBy`, one control event per change, and the operator's stop, which no route
// lifts. The domain's own cases are linkedin's tests/safety/kill-switches.test.ts. It lives here: a
// module never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
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

// linkedin by its build's path, as src/modules.generated.ts loads it: the api does not list a module
// with a screen (core/apps/web/docs/screens.md).
const build = new URL("../../../../modules/linkedin/dist/", import.meta.url);
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
const testing: LinkedinTesting = await import(new URL("testing/index.js", build).href);
const { createConnectedAccount, setAccountPaused, setPlatformControls, setWorkspaceStopped } =
  testing;

const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
testing.useLinkedinClient(app);
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "linkedin", load: () => import(new URL("index.js", build).href) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app, owner: asRole("owner") },
  });
});
after(() => api?.close());

type Answer = { status: number; body: any };

/** A call to …/linkedin<path> in the workspace, as the user, from the app; a POST with its key. */
async function call(
  userId: string,
  workspaceId: string,
  method: string,
  path: string,
  options: { body?: unknown; key?: string } = {},
): Promise<Answer> {
  const cookie = signInAs(userId)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const headers: Record<string, string> = { cookie, "sec-fetch-site": "same-origin" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.key !== undefined) headers["idempotency-key"] = options.key;
  const url = new URL(`/v1/workspaces/${workspaceId}/linkedin${path}`, api.url);
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

/** The control events, oldest first: scope, account, states, actor. */
async function events() {
  const rows = await app.linkedinControlEvent.findMany({ orderBy: { id: "asc" } });
  return rows.map((row) => [
    row.scope,
    row.senderAccountId,
    `${row.fromState}>${row.toState}`,
    `${row.actorType}:${row.actor}`,
  ]);
}

const CLOSED = { sendingOpen: false, stopped: false, invitesPaused: false };

test("GET and PUT …/controls: a fresh database reads sending closed and nothing stopped; the tester's stop on, again, then off, one event each change; another workspace reads no stop; an outsider is 403; a body without `stopped` is 400", async () => {
  const [a, b] = await createTwoWorkspaces();
  const owner = a.user.id;
  const ws = a.workspace.id;
  const free = { platform: CLOSED, workspace: { stopped: false, stopSource: null } };
  const stopped = { platform: CLOSED, workspace: { stopped: true, stopSource: "tester" } };
  assert.deepEqual(await call(owner, ws, "GET", "/controls"), { status: 200, body: free });
  const on = { body: { stopped: true } };
  assert.deepEqual(await call(owner, ws, "PUT", "/controls", on), { status: 200, body: stopped });
  assert.deepEqual(await call(owner, ws, "PUT", "/controls", on), { status: 200, body: stopped });
  assert.deepEqual(await call(owner, ws, "GET", "/controls"), { status: 200, body: stopped });
  const other = await call(b.user.id, b.workspace.id, "GET", "/controls");
  assert.deepEqual(other, { status: 200, body: free });
  const off = { body: { stopped: false } };
  assert.deepEqual(await call(owner, ws, "PUT", "/controls", off), { status: 200, body: free });
  assert.deepEqual(await events(), [
    ["workspace", null, "off>tester", `user:${owner}`],
    ["workspace", null, "tester>off", `user:${owner}`],
  ]);

  // B's user is no member of A's workspace: alpha's can() evaluates no role, so that is who lacks it.
  const forbidden = { status: 403, body: { code: "forbidden" } };
  assert.deepEqual(await call(b.user.id, ws, "GET", "/controls"), forbidden);
  assert.deepEqual(await call(b.user.id, ws, "PUT", "/controls", on), forbidden);
  assert.equal((await call(owner, ws, "PUT", "/controls", { body: {} })).status, 400);
  assert.equal((await events()).length, 2, "a refused call changes nothing");
});

test("POST …/pause and …/unpause: the account answers paused and pausedBy; a double press under one Idempotency-Key acts once; another member pauses and cannot resume, not_account_owner; an outsider is 403; another workspace's account 404", async () => {
  const [a, b] = await createTwoWorkspaces();
  const owner = a.user.id;
  const ws = a.workspace.id;
  const { id } = await createConnectedAccount(ws, { ownerUserId: owner });
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId: ws });
  const press = (userId: string, action: string, key = randomUUID()) =>
    call(userId, ws, "POST", `/accounts/${id}/${action}`, { key });

  const key = randomUUID();
  const first = await press(owner, "pause", key);
  assert.equal(first.status, 200);
  assert.deepEqual(
    [first.body.id, first.body.paused, first.body.pausedBy, first.body.mine],
    [id, true, "tester", true],
  );
  assert.deepEqual(await press(owner, "pause", key), first);
  const listed = (await call(owner, ws, "GET", "/accounts")).body.accounts;
  assert.deepEqual(
    listed.map((account: Answer["body"]) => [account.id, account.paused, account.pausedBy]),
    [[id, true, "tester"]],
  );
  const notOwner = { status: 403, body: { code: "not_account_owner" } };
  assert.deepEqual(await press(member.id, "unpause"), notOwner);

  const again = randomUUID();
  const resumed = await press(owner, "unpause", again);
  assert.deepEqual(
    [resumed.status, resumed.body.paused, resumed.body.pausedBy],
    [200, false, null],
  );
  assert.deepEqual(await press(owner, "unpause", again), resumed);
  const byMember = await press(member.id, "pause");
  assert.deepEqual([byMember.status, byMember.body.paused, byMember.body.mine], [200, true, false]);
  assert.deepEqual(await events(), [
    ["account", id, "off>tester", `user:${owner}`],
    ["account", id, "tester>off", `user:${owner}`],
    ["account", id, "off>tester", `user:${member.id}`],
  ]);

  const forbidden = { status: 403, body: { code: "forbidden" } };
  const outsider = (action: string) =>
    call(b.user.id, ws, "POST", `/accounts/${id}/${action}`, { key: randomUUID() });
  assert.deepEqual(await outsider("pause"), forbidden);
  assert.deepEqual(await outsider("unpause"), forbidden);
  const elsewhere = await call(b.user.id, b.workspace.id, "POST", `/accounts/${id}/pause`, {
    key: randomUUID(),
  });
  assert.deepEqual(elsewhere, { status: 404, body: { code: "sender_account_not_found" } });
  const keyless = await call(owner, ws, "POST", `/accounts/${id}/unpause`);
  assert.equal(keyless.status, 400);
  assert.equal((await events()).length, 3, "a refused call changes nothing");
});

test("the operator's stop holds against the routes: unpause and PUT { stopped: false } answer stopped_by_operator and change nothing, a pause keeps the operator's; GET reads the platform's switches and the operator as the source", async () => {
  const [a] = await createTwoWorkspaces();
  const owner = a.user.id;
  const ws = a.workspace.id;
  const { id } = await createConnectedAccount(ws, { ownerUserId: owner });
  await setAccountPaused(id, "operator");
  await setWorkspaceStopped(ws, "operator");
  await setPlatformControls({ sendingOpen: true, stopped: true, invitesPaused: true });
  const byOperator = { status: 409, body: { code: "stopped_by_operator" } };
  const unpause = await call(owner, ws, "POST", `/accounts/${id}/unpause`, { key: randomUUID() });
  assert.deepEqual(unpause, byOperator);
  const lift = await call(owner, ws, "PUT", "/controls", { body: { stopped: false } });
  assert.deepEqual(lift, byOperator);
  const paused = await call(owner, ws, "POST", `/accounts/${id}/pause`, { key: randomUUID() });
  assert.deepEqual(
    [paused.status, paused.body.paused, paused.body.pausedBy],
    [200, true, "operator"],
  );
  assert.deepEqual(await call(owner, ws, "GET", "/controls"), {
    status: 200,
    body: {
      platform: { sendingOpen: true, stopped: true, invitesPaused: true },
      workspace: { stopped: true, stopSource: "operator" },
    },
  });
  assert.deepEqual(await events(), []);
});
