// campaigns' approval-mode route end to end (gamma-p4-070; core/modules/campaigns/README.md "Routes",
// "The approval mode"): the host started with identity, whose resolver reads the membership and its
// role on every request, and campaigns, whose route opens its own runs on this file's `app` client
// (useCampaignsClient), on the fake authentication adapter, in a schema of the worktree's database,
// answering real HTTP. An Owner's review_first_touches during the campaign's first 7 days is 409
// approval_mode_locked with the lock's end, and taken after it, the lock's end moved as the days
// leave it (setReviewLock); review_everything always; a repeat changes nothing; the campaign's GET
// answers the mode. A mode this version lacks is 400 approval_mode_unavailable and a body off its
// schema 400; a Member is 403 forbidden and an Admin sets it; another workspace's campaign and an
// unknown id are 404. It lives here: a module never imports a host.
import assert from "node:assert/strict";
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

// The module by its build's path, as src/modules.generated.ts loads it (campaigns-enrollments.test.ts).
const built = (path: string) =>
  new URL(`../../../../modules/${path}/index.js`, import.meta.url).href;
type Campaigns = typeof import("../../../modules/campaigns/dist/index.js");
type CampaignsTesting = typeof import("../../../modules/campaigns/dist/testing/index.js");
const campaigns: Campaigns = await import(built("campaigns/dist"));
const { setReviewLock, useCampaignsClient }: CampaignsTesting = await import(
  built("campaigns/dist/testing")
);

const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
useCampaignsClient(app);
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "campaigns", load: async () => campaigns },
    ],
    migrations: { url: migrations.toString() },
    clients: { app, owner: asRole("owner") },
  });
});
after(() => api?.close());

type Answer = { status: number; body: Record<string, unknown> };
/** A call from the app as the user to …/workspaces/<workspace>/campaigns<path>; JSON when a body. */
async function call(
  user: string,
  workspace: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const cookie = signInAs(user)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const headers: Record<string, string> = { cookie, "sec-fetch-site": "same-origin" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const method = body === undefined ? "GET" : "PUT";
  const url = new URL(`/v1/workspaces/${workspace}/campaigns${path}`, api.url);
  const json = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(url, { method, headers, body: json });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
/** PUT …/<campaignId>/approval-mode with the body, as the user. */
const setMode = (user: string, workspace: string, campaignId: string, body: unknown) =>
  call(user, workspace, `/${campaignId}/approval-mode`, body);

/** The workspace's seeded campaign, made by its Owner's first read; its id. */
async function seeded(owner: string, workspace: string): Promise<string> {
  const { body } = await call(owner, workspace, "");
  const [campaign] = body.campaigns as { id: string }[];
  assert.ok(campaign);
  return campaign.id;
}
const rowOf = (id: string) => app.campaign.findUniqueOrThrow({ where: { id } });
const refused = (status: number, code: string) => ({ status, body: { code } });
const EVERYTHING = "review_everything";
const FIRST_TOUCHES = "review_first_touches";

test("PUT …/approval-mode: an Owner's review_first_touches in the campaign's first 7 days is 409 approval_mode_locked with the lock's end, changing nothing; after them, taken with who and when; review_everything always; a repeat changes nothing; the GET answers the mode", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const id = await seeded(a.user.id, ws);
  const made = await rowOf(id);
  const lockedUntil = made.reviewLockedUntil.toISOString();
  const everything = { mode: EVERYTHING, effectiveMode: EVERYTHING, lockedUntil };
  assert.deepEqual((await call(a.user.id, ws, `/${id}`)).body.approvalMode, everything);

  assert.deepEqual(await setMode(a.user.id, ws, id, { mode: FIRST_TOUCHES }), {
    status: 409,
    body: { code: "approval_mode_locked", details: { lockedUntil } },
  });
  assert.deepEqual(await rowOf(id), made, "a refusal changes nothing");
  const kept = await setMode(a.user.id, ws, id, { mode: EVERYTHING });
  assert.deepEqual(kept, { status: 200, body: everything });
  assert.deepEqual(await rowOf(id), made, "the campaign's own mode changes nothing");

  // The 7 days over, as the days leave the lock.
  const ended = new Date(Date.now() - 60_000);
  await setReviewLock({ workspaceId: ws, campaignId: id, lockedUntil: ended });
  const lighter = {
    ...{ mode: FIRST_TOUCHES, effectiveMode: FIRST_TOUCHES },
    lockedUntil: ended.toISOString(),
  };
  assert.deepEqual(await setMode(a.user.id, ws, id, { mode: FIRST_TOUCHES }), {
    status: 200,
    body: lighter,
  });
  const set = await rowOf(id);
  assert.deepEqual([set.approvalMode, set.approvalModeSetBy], [FIRST_TOUCHES, a.user.id]);
  assert.ok(set.approvalModeSetAt instanceof Date, "when");
  assert.deepEqual(await setMode(a.user.id, ws, id, { mode: FIRST_TOUCHES }), {
    status: 200,
    body: lighter,
  });
  assert.deepEqual(await rowOf(id), set, "a repeat changes nothing");
  assert.deepEqual((await call(a.user.id, ws, `/${id}`)).body.approvalMode, lighter);
  assert.deepEqual(await setMode(a.user.id, ws, id, { mode: EVERYTHING }), {
    status: 200,
    body: { ...lighter, mode: EVERYTHING, effectiveMode: EVERYTHING },
  });
});

test("refused: a mode this version lacks is 400 approval_mode_unavailable and a body off its schema 400 validation_failed, each changing nothing", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const id = await seeded(a.user.id, ws);
  const made = await rowOf(id);
  for (const mode of ["review_exceptions", "REVIEW_EVERYTHING", " review_everything", "auto"]) {
    const answer = await setMode(a.user.id, ws, id, { mode });
    assert.deepEqual(answer, refused(400, "approval_mode_unavailable"), mode);
  }
  const offSchema = [
    {},
    { mode: "" },
    { mode: 1 },
    { mode: null },
    { mode: "x".repeat(65) },
    { mode: EVERYTHING, lockedUntil: "2026-01-01T00:00:00Z" },
    [],
  ];
  for (const body of offSchema) {
    const { status, body: answer } = await setMode(a.user.id, ws, id, body);
    assert.deepEqual([status, answer.code], [400, "validation_failed"], JSON.stringify(body));
  }
  assert.deepEqual(await rowOf(id), made);
});

test("a Member's change of the mode is 403 forbidden and changes nothing; an Admin's is taken; another workspace's campaign and an unknown id are 404 campaign_not_found", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const id = await seeded(a.user.id, ws);
  await setReviewLock({ workspaceId: ws, campaignId: id, lockedUntil: new Date(0) });
  const [member, admin] = [await createUser(), await createUser()];
  await createMembership({ userId: member.id, workspaceId: ws, role: "Member" });
  await createMembership({ userId: admin.id, workspaceId: ws, role: "Admin" });
  const before = await rowOf(id);
  for (const mode of [FIRST_TOUCHES, EVERYTHING]) {
    assert.deepEqual(await setMode(member.id, ws, id, { mode }), refused(403, "forbidden"));
  }
  assert.deepEqual(await rowOf(id), before);
  // The Member reads the mode without the right to change it.
  assert.equal((await call(member.id, ws, `/${id}`)).status, 200);
  const taken = await setMode(admin.id, ws, id, { mode: FIRST_TOUCHES });
  assert.deepEqual([taken.status, taken.body.mode], [200, FIRST_TOUCHES]);
  assert.equal((await rowOf(id)).approvalModeSetBy, admin.id);

  const ofB = await seeded(b.user.id, b.workspace.id);
  await setReviewLock({ workspaceId: b.workspace.id, campaignId: ofB, lockedUntil: new Date(0) });
  const theirs = await rowOf(ofB);
  const missing = refused(404, "campaign_not_found");
  assert.deepEqual(await setMode(a.user.id, ws, ofB, { mode: FIRST_TOUCHES }), missing);
  assert.deepEqual(await setMode(a.user.id, ws, "cmp_unknown", { mode: EVERYTHING }), missing);
  assert.deepEqual(await rowOf(ofB), theirs, "another workspace's stays as it was");
});
