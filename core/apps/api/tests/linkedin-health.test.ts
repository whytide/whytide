// linkedin's health routes over real HTTP (beta-p6-040; core/modules/linkedin/README.md "API",
// "Health"), the host started with identity and linkedin on the fake authentication adapter: the view,
// who reads it and who resumes, each refusal in its order, the resume's answer and what it wrote, one
// Idempotency-Key acting once, another workspace's account. It lives here: a module never imports a host.
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
const { createConnectedAccount, createHealthEvent, setHealth } = testing;

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
type Event = { from: string; to: string; trigger: string; metrics: object; acknowledged: boolean };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const COOLDOWN_MS = 72 * HOUR_MS;

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

/** The account in `state` until `endsIn` from now, its status read `checkedAgo` ago; no event. */
async function cooling(
  id: string,
  state: "restricted" | "checkpoint",
  options: { endsIn?: number; checkedAgo?: number } = {},
) {
  const { endsIn = -HOUR_MS, checkedAgo = MINUTE_MS } = options;
  const now = Date.now();
  const pausedUntil = new Date(now + endsIn);
  const at = new Date(pausedUntil.getTime() - COOLDOWN_MS);
  await setHealth(id, state, { pausedUntil, at });
  const data = {
    status: "connected" as const,
    statusCheckedAt: new Date(now - checkedAgo),
    connectedAt: new Date(at.getTime() - HOUR_MS),
  };
  await app.senderAccount.update({ where: { id }, data });
  return { pausedUntil, at };
}

const eventsOf = (body: { events: Event[] }) =>
  body.events.map((event) => [event.from, event.to, event.trigger, event.acknowledged]);

test("GET …/accounts/{id}/health answers the card's view: a healthy account with nothing to resume; restricted with its cool-down over and a fresh status, the change's trigger and time (a third error's event aside), the end, canResume for the owner alone, the events newest first with their numbers; a member reads not_account_owner as the block; an outsider is 403, another workspace's account 404", async () => {
  const [a, b] = await createTwoWorkspaces();
  const owner = a.user.id;
  const ws = a.workspace.id;
  const { id } = await createConnectedAccount(ws, { ownerUserId: owner, pendingInvites: 12 });
  const read = (userId: string, workspaceId = ws) =>
    call(userId, workspaceId, "GET", `/accounts/${id}/health`);

  const fresh = await read(owner);
  assert.equal(fresh.status, 200);
  const { pendingInvitesCheckedAt, statusCheckedAt, ...healthy } = fresh.body;
  assert.equal(typeof pendingInvitesCheckedAt, "string");
  assert.deepEqual(healthy, {
    state: "healthy",
    trigger: null,
    since: null,
    pausedUntil: null,
    status: "connected",
    canResume: false,
    resumeBlockedBy: "account_not_paused",
    invitesPaused: false,
    pendingInvites: 12,
    acceptance: { sample: 0, accepted: 0, rate: null },
    events: [],
  });

  const { pausedUntil, at } = await cooling(id, "restricted");
  const change = { from: "healthy", to: "restricted", trigger: "limit_reached" } as const;
  await createHealthEvent(id, { ...change, at, pausedUntil });
  const third = { from: "restricted", to: "restricted", trigger: "rate_limit_errors" } as const;
  await createHealthEvent(id, { ...third, at: new Date(+at + HOUR_MS), metrics: { errors: 3 } });
  const view = (await read(owner)).body;
  assert.deepEqual(
    [view.state, view.trigger, view.since, view.pausedUntil, view.canResume, view.resumeBlockedBy],
    ["restricted", "limit_reached", at.toISOString(), pausedUntil.toISOString(), true, null],
  );
  assert.deepEqual(eventsOf(view), [
    ["restricted", "restricted", "rate_limit_errors", false],
    ["healthy", "restricted", "limit_reached", false],
  ]);
  assert.deepEqual(view.events[0].metrics, { errors: 3 });

  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId: ws });
  const byMember = await read(member.id);
  assert.deepEqual(
    [byMember.status, byMember.body.canResume, byMember.body.resumeBlockedBy],
    [200, false, "not_account_owner"],
  );
  assert.deepEqual(await read(b.user.id), { status: 403, body: { code: "forbidden" } });
  assert.deepEqual(await read(b.user.id, b.workspace.id), {
    status: 404,
    body: { code: "sender_account_not_found" },
  });
});

test("POST …/accounts/{id}/resume refuses in order, changing nothing: a healthy account account_not_paused; another member not_account_owner (403); a cool-down running cooldown_active with details.pausedUntil; a lost session linkedin_account_disconnected; a checkpoint with no pairing since reconnect_required; a status read before the end, or more than 10 minutes ago, status_check_required (409 each); a field in the body or no key is 400; an outsider is 403, another workspace's account 404", async () => {
  const [a, b] = await createTwoWorkspaces();
  const owner = a.user.id;
  const ws = a.workspace.id;
  const { id } = await createConnectedAccount(ws, { ownerUserId: owner });
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId: ws });
  const press = (userId: string, workspaceId = ws, body: unknown = {}) =>
    call(userId, workspaceId, "POST", `/accounts/${id}/resume`, { body, key: randomUUID() });
  const refused = (code: string, details?: object) => ({
    status: code === "not_account_owner" ? 403 : 409,
    body: details === undefined ? { code } : { code, details },
  });

  assert.deepEqual(await press(owner), refused("account_not_paused"));
  const { pausedUntil } = await cooling(id, "restricted", { endsIn: HOUR_MS });
  assert.deepEqual(await press(member.id), refused("not_account_owner"));
  const details = { pausedUntil: pausedUntil.toISOString() };
  assert.deepEqual(await press(owner), refused("cooldown_active", details));
  await cooling(id, "restricted");
  await app.senderAccount.update({ where: { id }, data: { status: "credentials_required" } });
  assert.deepEqual(await press(owner), refused("linkedin_account_disconnected"));
  await cooling(id, "checkpoint");
  assert.deepEqual(await press(owner), refused("reconnect_required"));
  await cooling(id, "restricted", { checkedAgo: 2 * HOUR_MS });
  assert.deepEqual(await press(owner), refused("status_check_required"), "read before the end");
  await cooling(id, "restricted", { checkedAgo: 11 * MINUTE_MS });
  assert.deepEqual(await press(owner), refused("status_check_required"), "11 minutes old");

  await cooling(id, "restricted");
  assert.equal((await press(owner, ws, { now: true })).status, 400);
  const keyless = await call(owner, ws, "POST", `/accounts/${id}/resume`, { body: {} });
  assert.equal(keyless.status, 400);
  assert.deepEqual(await press(b.user.id), { status: 403, body: { code: "forbidden" } });
  assert.deepEqual(await press(b.user.id, b.workspace.id), {
    status: 404,
    body: { code: "sender_account_not_found" },
  });
  const row = await app.senderAccount.findUniqueOrThrow({ where: { id } });
  assert.deepEqual(
    [row.healthState, row.inviteTarget, row.messageTarget, row.rampUpdatedOn],
    ["restricted", 5, 10, null],
  );
  assert.equal(await app.senderHealthEvent.count({ where: { senderId: id } }), 0);
});

test("the owner's resume answers 200 with the account's health: healthy, the targets halved (15 and 40 to 7 and 20) with ramp_updated_on today, the pausing event and the resume's acknowledged; the same Idempotency-Key answers it again and acts once, another key is account_not_paused", async () => {
  const [a] = await createTwoWorkspaces();
  const owner = a.user.id;
  const ws = a.workspace.id;
  const { id } = await createConnectedAccount(ws, { ownerUserId: owner });
  await app.senderAccount.update({ where: { id }, data: { inviteTarget: 15, messageTarget: 40 } });
  const { pausedUntil, at } = await cooling(id, "restricted");
  const change = { from: "healthy", to: "restricted", trigger: "limit_reached" } as const;
  await createHealthEvent(id, { ...change, at, pausedUntil });
  const press = (key: string) =>
    call(owner, ws, "POST", `/accounts/${id}/resume`, { body: {}, key });

  const key = randomUUID();
  const resumed = await press(key);
  assert.equal(resumed.status, 200);
  const view = resumed.body;
  assert.deepEqual(
    [view.state, view.trigger, view.pausedUntil, view.canResume, view.resumeBlockedBy],
    ["healthy", "manual", null, false, "account_not_paused"],
  );
  assert.deepEqual(eventsOf(view), [
    ["restricted", "healthy", "manual", true],
    ["healthy", "restricted", "limit_reached", true],
  ]);
  const row = await app.senderAccount.findUniqueOrThrow({ where: { id } });
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(
    [row.healthState, row.pausedUntil, row.inviteTarget, row.messageTarget, row.rampUpdatedOn],
    ["healthy", null, 7, 20, today],
  );

  assert.deepEqual(await press(key), resumed, "the same key: the same answer");
  assert.equal(await app.senderHealthEvent.count({ where: { senderId: id } }), 2, "acted once");
  assert.deepEqual(await press(randomUUID()), {
    status: 409,
    body: { code: "account_not_paused" },
  });
});

test("who reads and resumes an account's health (gamma-p6-070): its owner, a Member, reads it and reaches the resume's own checks, account_not_paused, not the route's 403; an Owner reads it, resumeBlockedBy not_account_owner; a teammate Member is 403 not_account_owner on both", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const [member, teammate] = [await createUser(), await createUser()];
  for (const { id: userId } of [member, teammate]) {
    await createMembership({ userId, workspaceId: ws, role: "Member" });
  }
  const { id } = await createConnectedAccount(ws, { ownerUserId: member.id });
  const read = (userId: string) => call(userId, ws, "GET", `/accounts/${id}/health`);
  const resume = (userId: string) =>
    call(userId, ws, "POST", `/accounts/${id}/resume`, { body: {}, key: randomUUID() });
  const own = await read(member.id);
  assert.deepEqual([own.status, own.body.resumeBlockedBy], [200, "account_not_paused"]);
  assert.deepEqual(await resume(member.id), { status: 409, body: { code: "account_not_paused" } });
  const byOwner = await read(a.user.id);
  assert.deepEqual([byOwner.status, byOwner.body.resumeBlockedBy], [200, "not_account_owner"]);
  const notOwner = { status: 403, body: { code: "not_account_owner" } };
  assert.deepEqual(await read(teammate.id), notOwner);
  assert.deepEqual(await resume(teammate.id), notOwner);
});
