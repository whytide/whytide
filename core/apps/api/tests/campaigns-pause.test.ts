// campaigns' pause and resume routes end to end (gamma-p3-061; core/modules/campaigns/README.md
// "Routes", "Pausing"): the host started with identity, whose resolver reads the membership and its
// role on every request, and campaigns, on the fake authentication adapter, in a schema of the
// worktree's database, answering real HTTP. A campaign and an enrollment paused and resumed, their
// waiting steps' codes cleared; the wrong state refused 409 with its code, a draft included; an id
// the workspace does not hold, another workspace's included, 404, which changes nothing there; and
// the seeded campaign is its Owner's (gamma-p6-015): a Member is 403 forbidden on all four, which
// changes nothing, and an Admin, holding campaigns.manage, resumes.
// The enrollments are written as campaigns leaves them (@whytide/campaigns/testing). It lives here:
// a module never imports a host.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, newId } from "@whytide/platform";
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
const { createEnrollment }: CampaignsTesting = await import(built("campaigns/dist/testing"));

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
async function call(user: string, workspace: string, path: string, body?: object): Promise<Answer> {
  const cookie = signInAs(user)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const headers: Record<string, string> = { cookie, "sec-fetch-site": "same-origin" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const method = path.endsWith("/pause") || path.endsWith("/resume") ? "POST" : "GET";
  const url = new URL(`/v1/workspaces/${workspace}/campaigns${path}`, api.url);
  const json = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(url, { method, headers, body: json });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The workspace's seeded campaign, made by its Owner's first read; its id. */
async function seeded(owner: string, workspace: string): Promise<string> {
  const { body } = await call(owner, workspace, "");
  const [campaign] = body.campaigns as { id: string }[];
  assert.ok(campaign);
  return campaign.id;
}

const refused = (status: number, code: string) => ({ status, body: { code } });
const FORBIDDEN = refused(403, "forbidden");
const SENDER = "sac_pause_routes";
/** A step waiting on a pause, as the claim's gate leaves it. */
const waitingOn = (errorCode: string) =>
  ({ stepKey: "connect", status: "scheduled", errorCode }) as const;
const codeOf = async (id: string) =>
  (await app.stepExecution.findUniqueOrThrow({ where: { id } })).errorCode;
const statusOf = {
  campaign: async (id: string) => (await app.campaign.findUniqueOrThrow({ where: { id } })).status,
  enrollment: async (id: string) =>
    (await app.enrollment.findUniqueOrThrow({ where: { id } })).status,
};

test("POST …/campaigns/{campaignId}/pause and …/resume pause the active campaign as a member's and resume it, its waiting step's code cleared; the wrong state, a draft's included, is 409 with its code", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const id = await seeded(a.user.id, ws);
  const { stepIds } = await createEnrollment({
    ...{ workspaceId: ws, personId: "per_pause_campaign", senderAccountId: SENDER },
    steps: [waitingOn("campaign_not_active")],
  });
  const [step = ""] = stepIds;

  const paused = await call(a.user.id, ws, `/${id}/pause`);
  const pausedAt = String(paused.body.pausedAt);
  assert.ok(!Number.isNaN(Date.parse(pausedAt)), "paused now");
  assert.deepEqual(paused, {
    status: 200,
    body: { id, status: "paused", pausedReason: "user", pausedAt },
  });
  assert.equal((await call(a.user.id, ws, `/${id}`)).body.status, "paused");
  assert.deepEqual(await call(a.user.id, ws, `/${id}/pause`), refused(409, "campaign_not_active"));
  assert.deepEqual(await call(a.user.id, ws, `/${id}/resume`), {
    status: 200,
    body: { id, status: "active", pausedReason: null, pausedAt: null },
  });
  assert.equal(await codeOf(step), null, "the plan places it again");
  assert.deepEqual(await call(a.user.id, ws, `/${id}/resume`), refused(409, "campaign_not_paused"));

  // A draft, written as createCampaign leaves one, has not started: neither paused nor resumed.
  const draft = newId(campaigns.ids.campaign);
  await app.campaign.create({
    data: {
      ...{ id: draft, workspaceId: ws, keyRef: draft, name: "Not launched", status: "draft" },
      ...{ ownerUserId: a.user.id, createdBy: a.user.id },
    },
  });
  assert.deepEqual(
    await call(a.user.id, ws, `/${draft}/pause`),
    refused(409, "campaign_not_active"),
  );
  assert.deepEqual(
    await call(a.user.id, ws, `/${draft}/resume`),
    refused(409, "campaign_not_paused"),
  );
});

test("POST …/campaigns/enrollments/{enrollmentId}/pause, until a time or not, and …/resume pause the active enrollment as a member's and resume it, its waiting step's code cleared; the wrong state is 409 with its code, an until off the schema 400", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const personId = "per_pause_enrollment";
  const { id, stepIds } = await createEnrollment({
    ...{ workspaceId: ws, personId, senderAccountId: SENDER },
    steps: [waitingOn("enrollment_paused")],
  });
  const [step = ""] = stepIds;
  const path = `/enrollments/${id}`;
  const until = "2026-11-10T09:00:00.000Z";

  assert.deepEqual(await call(a.user.id, ws, `${path}/pause`, { until }), {
    status: 200,
    body: { id, status: "paused", pausedReason: "user", pausedUntil: until },
  });
  const { body } = await call(a.user.id, ws, `/enrollments?personId=${personId}`);
  const [listed] = body.enrollments as Record<string, unknown>[];
  assert.deepEqual(
    [listed?.id, listed?.status, listed?.pausedReason, listed?.pausedUntil, listed?.campaignName],
    [id, "paused", "user", until, ""],
  );
  assert.deepEqual(
    await call(a.user.id, ws, `${path}/pause`, {}),
    refused(409, "enrollment_not_active"),
  );
  const active = { id, status: "active", pausedReason: null, pausedUntil: null };
  assert.deepEqual(await call(a.user.id, ws, `${path}/resume`), { status: 200, body: active });
  assert.equal(await codeOf(step), null, "the plan places it again");
  assert.deepEqual(
    await call(a.user.id, ws, `${path}/resume`),
    refused(409, "enrollment_not_paused"),
  );
  // Without a time, until a member resumes it.
  assert.deepEqual(await call(a.user.id, ws, `${path}/pause`, {}), {
    status: 200,
    body: { ...active, status: "paused", pausedReason: "user" },
  });
  assert.deepEqual(await call(a.user.id, ws, `${path}/pause`, { until: "next week" }), {
    status: 400,
    body: { code: "validation_failed", details: { fields: ["until"] } },
  });
  // One that ended is neither paused nor resumed.
  const ended = await createEnrollment({
    ...{ workspaceId: ws, personId: "per_pause_ended", senderAccountId: SENDER },
    status: "completed",
  });
  const endedPath = `/enrollments/${ended.id}`;
  assert.deepEqual(
    await call(a.user.id, ws, `${endedPath}/pause`, {}),
    refused(409, "enrollment_not_active"),
  );
  assert.deepEqual(
    await call(a.user.id, ws, `${endedPath}/resume`),
    refused(409, "enrollment_not_paused"),
  );
});

test("another workspace's campaign and enrollment are 404, as unknown ids are, and stay as they were", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  await seeded(a.user.id, ws);
  const campaignOfB = await seeded(b.user.id, b.workspace.id);
  const enrollmentOfB = (
    await createEnrollment({
      ...{ workspaceId: b.workspace.id, personId: "per_pause_b", senderAccountId: SENDER },
    })
  ).id;
  for (const id of [campaignOfB, "cmp_unknown"]) {
    for (const move of ["pause", "resume"]) {
      const answer = await call(a.user.id, ws, `/${id}/${move}`);
      assert.deepEqual(answer, refused(404, "campaign_not_found"), `${id} ${move}`);
    }
  }
  for (const id of [enrollmentOfB, "enl_unknown"]) {
    const pause = await call(a.user.id, ws, `/enrollments/${id}/pause`, {});
    const resume = await call(a.user.id, ws, `/enrollments/${id}/resume`);
    for (const answer of [pause, resume]) {
      assert.deepEqual(answer, refused(404, "enrollment_not_found"), id);
    }
  }
  assert.equal(await statusOf.campaign(campaignOfB), "active");
  assert.equal(await statusOf.enrollment(enrollmentOfB), "active");
});

test("the seeded campaign is its Owner's: a Member is 403 forbidden on the four routes, which change nothing, and still reads; an Admin, holding campaigns.manage, resumes", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId: ws, role: "Member" });
  const campaignId = await seeded(a.user.id, ws);
  const { id } = await createEnrollment({
    ...{ workspaceId: ws, personId: "per_pause_member", senderAccountId: SENDER },
  });
  const moves = async () => [
    await call(member.id, ws, `/${campaignId}/pause`),
    await call(member.id, ws, `/${campaignId}/resume`),
    await call(member.id, ws, `/enrollments/${id}/pause`, {}),
    await call(member.id, ws, `/enrollments/${id}/resume`),
  ];
  assert.deepEqual(await moves(), [FORBIDDEN, FORBIDDEN, FORBIDDEN, FORBIDDEN]);
  assert.deepEqual(
    [await statusOf.campaign(campaignId), await statusOf.enrollment(id)],
    ["active", "active"],
  );
  // Paused by the Owner: the Member's resumes are refused as well, and both stay paused.
  assert.equal((await call(a.user.id, ws, `/${campaignId}/pause`)).status, 200);
  assert.equal((await call(a.user.id, ws, `/enrollments/${id}/pause`, {})).status, 200);
  assert.deepEqual(await moves(), [FORBIDDEN, FORBIDDEN, FORBIDDEN, FORBIDDEN]);
  assert.deepEqual(
    [await statusOf.campaign(campaignId), await statusOf.enrollment(id)],
    ["paused", "paused"],
  );
  assert.equal((await call(member.id, ws, `/${campaignId}`)).status, 200, "campaigns.read");

  const admin = await createUser();
  await createMembership({ userId: admin.id, workspaceId: ws, role: "Admin" });
  assert.equal((await call(admin.id, ws, `/enrollments/${id}/resume`)).status, 200);
  assert.equal((await call(admin.id, ws, `/${campaignId}/resume`)).status, 200);
});
