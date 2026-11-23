// campaigns' sequence and name routes end to end (gamma-p3-050; core/modules/campaigns/README.md
// "Routes", "Campaigns and versions"): the host started with identity and campaigns, on the fake
// authentication adapter, in a schema of the worktree's database, answering real HTTP. PUT
// …/sequence saves the editor's list as the next version through saveVersion, answering its number
// and steps, an enrollment in flight keeping its rows and the same list writing nothing; the
// fallback's checkbox puts the condition on every email, the first then 7 days after the invitation,
// or on none; a rule broken is 400 with its rule and saves nothing. PATCH renames the campaign, its
// name trimmed. The campaign's GET answers the editor's limits, the setting's default here.
// Another workspace's campaign is 404 and a Member 403 on both, changing nothing. The
// enrollment is written as campaigns leaves one (@whytide/campaigns/testing). It lives here: a
// module never imports a host.
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
/** A call from the app as the user to …/workspaces/<workspace>/campaigns<path>, JSON when a body. */
async function call(user: string, ws: string, method: string, path: string, body?: object) {
  const cookie = signInAs(user)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const headers: Record<string, string> = { cookie, "sec-fetch-site": "same-origin" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const url = new URL(`/v1/workspaces/${ws}/campaigns${path}`, api.url);
  const json = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(url, { method, headers, body: json });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> } as Answer;
}

/** The workspace's seeded campaign, made by its Owner's first read; its id. */
async function seeded(owner: string, ws: string): Promise<string> {
  const [campaign] = (await call(owner, ws, "GET", "")).body.campaigns as { id: string }[];
  assert.ok(campaign);
  return campaign.id;
}

const versions = (campaignId: string) => app.campaignVersion.count({ where: { campaignId } });
const refused = (status: number, code: string) => ({ status, body: { code } });
const CONNECT = { action: "invite" };
const FIRST_MESSAGE = { action: "message" };
const message = (days: number) => ({ action: "message", delayBusinessDays: days });
const email = (days?: number) =>
  days === undefined ? { action: "email" } : { action: "email", delayBusinessDays: days };
const later = (value: number) => ({ anchor: "prev_step", unit: "business_days", value });
const DRAW = { anchor: "accepted", unit: "hours", min: 1, max: 3, minMinutes: 10 };
const FALLBACK = { condition: "invite_not_accepted_within" };
/** A step as the routes answer it. */
const step = (position: number, stepKey: string, delay: object, more: object = {}) => {
  const action =
    stepKey === "connect" ? "invite" : stepKey.startsWith("email") ? "email" : "message";
  const channel = action === "email" ? "email" : "linkedin";
  return { position, stepKey, action, channel, delay, ...more };
};
const CONNECT_STEP = step(1, "connect", { anchor: "enrollment" });
const FIRST_MESSAGE_STEP = step(2, "message_1", DRAW);

test("PUT …/sequence saves the editor's list as the campaign's next version and answers its number and steps; an enrollment in flight keeps its rows; the same list again writes nothing", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const id = await seeded(a.user.id, ws);
  const { id: enrollmentId } = await createEnrollment({
    ...{ workspaceId: ws, personId: "per_in_flight", senderAccountId: "sac_in_flight" },
    steps: [
      { stepKey: "connect", status: "succeeded", executedAt: new Date("2026-11-02T10:00:00Z") },
      { stepKey: "message_1", status: "planned" },
      { stepKey: "follow_up_1", status: "planned" },
      { stepKey: "follow_up_2", status: "planned" },
    ],
  });
  const rows = async () => ({
    enrollment: await app.enrollment.findUniqueOrThrow({ where: { id: enrollmentId } }),
    steps: await app.stepExecution.findMany({ where: { enrollmentId }, orderBy: { id: "asc" } }),
  });
  const before = await rows();

  const body = { steps: [CONNECT, FIRST_MESSAGE, message(2)], emailFallback: false };
  const saved = await call(a.user.id, ws, "PUT", `/${id}/sequence`, body);
  const steps = [CONNECT_STEP, FIRST_MESSAGE_STEP, step(3, "follow_up_1", later(2))];
  assert.deepEqual(saved, { status: 200, body: { versionNo: 2, steps } });
  const read = await call(a.user.id, ws, "GET", `/${id}`);
  assert.deepEqual([read.body.versionNo, read.body.steps], [2, steps], "the current version");
  assert.deepEqual(await rows(), before, "the enrollment in flight keeps its version and steps");

  assert.deepEqual(await call(a.user.id, ws, "PUT", `/${id}/sequence`, body), saved);
  assert.equal(await versions(id), 2, "the same list writes nothing");
});

test("PUT …/sequence with the fallback's checkbox on puts the condition on every email, the first 7 days after the invitation; off, on none", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const id = await seeded(a.user.id, ws);

  const on = [CONNECT, FIRST_MESSAGE, message(3), email(), email(3)];
  assert.deepEqual(
    await call(a.user.id, ws, "PUT", `/${id}/sequence`, { steps: on, emailFallback: true }),
    {
      status: 200,
      body: {
        versionNo: 2,
        steps: [
          ...[CONNECT_STEP, FIRST_MESSAGE_STEP, step(3, "follow_up_1", later(3))],
          step(4, "email_1", { anchor: "invite_sent", unit: "days", value: 7 }, FALLBACK),
          step(5, "email_2", later(3), FALLBACK),
        ],
      },
    },
  );

  const off = [CONNECT, FIRST_MESSAGE, email(2), email(3)];
  assert.deepEqual(
    await call(a.user.id, ws, "PUT", `/${id}/sequence`, { steps: off, emailFallback: false }),
    {
      status: 200,
      body: {
        versionNo: 3,
        steps: [
          ...[CONNECT_STEP, FIRST_MESSAGE_STEP, step(3, "email_1", later(2))],
          step(4, "email_2", later(3)),
        ],
      },
    },
  );
});

test("PUT …/sequence off a rule is 400 campaign_sequence_invalid with the rule, a body off its schema 400 validation_failed and an archived campaign 409 campaign_archived, each saving nothing", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const id = await seeded(a.user.id, ws);
  const save = (steps: object[], emailFallback = false) =>
    call(a.user.id, ws, "PUT", `/${id}/sequence`, { steps, emailFallback });
  const rules: [object[], boolean, string][] = [
    [[FIRST_MESSAGE, CONNECT], false, "connect_first"],
    [[CONNECT, CONNECT], false, "connect_once"],
    [[CONNECT, FIRST_MESSAGE, message(1), message(1), message(1)], false, "channel_limit"],
    [[CONNECT, message(1)], false, "first_message"],
    [[CONNECT, FIRST_MESSAGE, message(0)], false, "step_delay"],
    [[CONNECT, FIRST_MESSAGE, message(31)], false, "step_delay"],
    [[CONNECT, FIRST_MESSAGE, email()], false, "step_delay"],
    [[CONNECT, FIRST_MESSAGE, email(7)], true, "fallback"],
  ];
  for (const [steps, emailFallback, rule] of rules) {
    assert.deepEqual(await save(steps, emailFallback), {
      status: 400,
      body: { code: "campaign_sequence_invalid", details: { rule } },
    });
  }
  for (const steps of [[], Array(8).fill(CONNECT), [{ action: "withdraw" }]]) {
    const { status, body } = await save(steps);
    assert.deepEqual([status, body.code], [400, "validation_failed"]);
  }
  await app.campaign.update({ where: { id }, data: { status: "archived" } });
  assert.deepEqual(await save([CONNECT]), refused(409, "campaign_archived"));
  assert.equal(await versions(id), 1, "nothing saved");
});

test("GET …/campaigns/{campaignId} answers the editor's limits, CAMPAIGNS_MAX_STEP_DELAY_BUSINESS_DAYS unset its default 30: a 30-day delay saves, a 31-day one is step_delay above", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const id = await seeded(a.user.id, ws);
  // campaigns' tests/settings.test.ts sets another value, and the OpenAPI equality test the document.
  const { body } = await call(a.user.id, ws, "GET", `/${id}`);
  assert.deepEqual(body.limits, { maxStepDelayBusinessDays: 30 });
  const steps = [CONNECT, FIRST_MESSAGE, message(30)];
  const saved = await call(a.user.id, ws, "PUT", `/${id}/sequence`, {
    steps,
    emailFallback: false,
  });
  assert.equal(saved.status, 200);
});

test("PATCH …/campaigns/{campaignId} renames the campaign, its name trimmed; a name outside 1 to 80 characters is 400 campaign_name_invalid and changes nothing", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const id = await seeded(a.user.id, ws);
  assert.deepEqual(await call(a.user.id, ws, "PATCH", `/${id}`, { name: "  Warm leads  " }), {
    status: 200,
    body: { id, name: "Warm leads" },
  });
  for (const name of [" ", "x".repeat(81)]) {
    const answer = await call(a.user.id, ws, "PATCH", `/${id}`, { name });
    assert.deepEqual(answer, refused(400, "campaign_name_invalid"));
  }
  assert.equal((await call(a.user.id, ws, "GET", `/${id}`)).body.name, "Warm leads");
});

test("another workspace's campaign is 404 campaign_not_found on PUT …/sequence and PATCH, as an unknown id, and a Member is 403 forbidden on both; neither changes it", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ofB = await seeded(b.user.id, b.workspace.id);
  const member = await createUser();
  const ws = a.workspace.id;
  await createMembership({ userId: member.id, workspaceId: ws, role: "Member" });
  const ofA = await seeded(a.user.id, ws);
  const sequence = { steps: [CONNECT], emailFallback: false };
  const missing = refused(404, "campaign_not_found");
  for (const campaignId of [ofB, "cmp_unknown"]) {
    assert.deepEqual(
      await call(a.user.id, ws, "PUT", `/${campaignId}/sequence`, sequence),
      missing,
    );
    assert.deepEqual(await call(a.user.id, ws, "PATCH", `/${campaignId}`, { name: "A" }), missing);
  }
  const forbidden = refused(403, "forbidden");
  assert.deepEqual(await call(member.id, ws, "PUT", `/${ofA}/sequence`, sequence), forbidden);
  assert.deepEqual(await call(member.id, ws, "PATCH", `/${ofA}`, { name: "A" }), forbidden);
  assert.deepEqual([await versions(ofA), await versions(ofB)], [1, 1]);
  const names = await app.campaign.findMany({ select: { name: true } });
  assert.deepEqual(names, [{ name: "" }, { name: "" }]);
});
