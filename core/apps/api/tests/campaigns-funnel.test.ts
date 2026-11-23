// campaigns' funnel route end to end (gamma-p6-080; core/modules/campaigns/README.md "Routes"): the
// host started with identity and campaigns, on the fake authentication adapter, in a schema of the
// worktree's database, answering real HTTP, with campaigns' clock fixed (useClock). The Results
// page's numbers per campaign: each on seeded rows, the seeded campaign made on first use; an Owner
// sees every campaign with its owner's name, a Member her own without names, a Member without one
// an empty list; another workspace's rows never count; a non-member is refused. The rows are
// written as campaigns, its sender and the reply labels leave them, by campaigns' createEnrollment;
// the measures' every rule is the module's test (core/modules/campaigns/tests/funnel.test.ts). It
// lives here: a module never imports a host.
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

// The modules by their builds' paths, as src/modules.generated.ts loads them: the api lists no module
// with a screen (core/apps/web/docs/screens.md). The testing entry shares the build's clock.
const built = (path: string) =>
  new URL(`../../../../modules/${path}/index.js`, import.meta.url).href;
type Campaigns = typeof import("../../../modules/campaigns/dist/index.js");
type CampaignsTesting = typeof import("../../../modules/campaigns/dist/testing/index.js");
type Seeded = Parameters<CampaignsTesting["createEnrollment"]>[0];
type Step = NonNullable<Seeded["steps"]>[number];
const campaigns: Campaigns = await import(built("campaigns/dist"));
const testing: CampaignsTesting = await import(built("campaigns/dist/testing"));

const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
let api: Api;

const NOW = "2026-11-12T06:00:00.000Z";

before(async () => {
  testing.useClock(() => new Date(NOW));
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
after(async () => {
  testing.useClock(undefined);
  await api?.close();
});

/** GET …/campaigns/funnel of the workspace, signed in as the user. */
async function read(userId: string, workspaceId: string) {
  const cookie = signInAs(userId).map(({ name, value }) => `${name}=${value}`);
  const path = `/v1/workspaces/${workspaceId}/campaigns/funnel`;
  const res = await fetch(new URL(path, api.url), { headers: { cookie: cookie.join("; ") } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A member of the workspace with the role: a new user. */
async function member(workspaceId: string, role: "Admin" | "Member") {
  const user = await createUser();
  await createMembership({ userId: user.id, workspaceId, role });
  return user;
}

/** An active campaign of the owner's; its id, its key_ref too. */
async function campaign(workspaceId: string, ownerUserId: string, name: string) {
  const { id } = await testing.createDraftCampaign({ workspaceId, ownerUserId, name }, app);
  await testing.setCampaignActive({ workspaceId, campaignId: id }, app);
  return id;
}

let people = 0;
/** An enrollment of a new person in the campaign; the person's id. */
async function enroll(workspaceId: string, templateId: string, rest: Partial<Seeded> = {}) {
  const personId = `per_funnel_${++people}`;
  const seeded: Seeded = { workspaceId, personId, senderAccountId: "sac_funnel", templateId };
  await testing.createEnrollment({ ...seeded, ...rest }, app);
  return personId;
}

/** The hour on 11 November 2026, UTC, the day before now. */
const at = (hour: number) => new Date(Date.UTC(2026, 10, 11, hour));
function sent(stepKey: string, hour: number, more: Partial<Step> = {}): Step {
  const step: Step = { stepKey, status: "succeeded", executedAt: at(hour) };
  return { ...step, ...more };
}
const emailed = (hour: number) => sent("email_1", hour, { actionType: "email" });
function replied(label: string, hour: number): Partial<Seeded> {
  return { status: "replied", endedAt: at(hour), reply: { label, at: at(hour) } };
}

/** A campaign's numbers as the route answers them. */
function numbers(
  enrolled: number,
  [sent, accepted, replies, positive]: number[],
  [emails, emailReplies, emailPositive]: number[],
  [allReplies, allPositive]: number[],
) {
  return {
    enrolled,
    linkedin: { sent, accepted, replied: replies, positive },
    email: { sent: emails, accepted: null, replied: emailReplies, positive: emailPositive },
    total: { replied: allReplies, positive: allPositive },
  };
}
const NONE = numbers(0, [0, 0, 0, 0], [0, 0, 0], [0, 0]);

test("GET …/campaigns/funnel answers an Owner every campaign by name, the seeded one made on first use, each with its owner's name and its numbers: enrolled, then sent, accepted, replied and positive on LinkedIn and by email; ids, names, codes and numbers only", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const mia = await member(ws, "Member");
  const outbound = await campaign(ws, mia.id, "Outbound");
  const people = [
    // Accepted, then a positive reply to the first message.
    await enroll(ws, outbound, {
      ...replied("interested", 5),
      steps: [sent("connect", 1, { acceptedAt: at(2) }), sent("message_1", 3)],
    }),
    // A reply to the email: by email, not positive.
    await enroll(ws, outbound, {
      ...replied("not_now", 6),
      steps: [sent("connect", 1), emailed(4)],
    }),
    // An out-of-office answer and a bounce: no reply.
    await enroll(ws, outbound, {
      reply: { label: "out_of_office", at: at(3) },
      steps: [sent("connect", 1)],
    }),
    await enroll(ws, outbound, { reply: { label: "bounce", at: at(3) }, steps: [emailed(2)] }),
    // Beta's enrollment, in the seeded campaign: the default key_ref.
    await enroll(ws, "linkedin_default", {
      steps: [sent("connect", 1), sent("message_1", 2), sent("follow_up_1", 3)],
    }),
  ];

  const { status, body } = await read(a.user.id, ws);
  assert.equal(status, 200);
  const [seeded] = await app.campaign.findMany({
    where: { workspaceId: ws, keyRef: "linkedin_default" },
  });
  assert.ok(seeded, "the route makes the seeded campaign on first use");
  assert.deepEqual(body, {
    asOf: NOW,
    campaigns: [
      {
        ...{ campaignId: seeded.id, name: "", status: "active", ownerName: a.user.displayName },
        ...numbers(1, [1, 0, 0, 0], [0, 0, 0], [0, 0]),
      },
      {
        ...{ campaignId: outbound, name: "Outbound", status: "active", ownerName: mia.displayName },
        ...numbers(4, [3, 1, 1, 1], [2, 1, 0], [2, 1]),
      },
    ],
  });
  // No person: not even an id, and no email address.
  const text = JSON.stringify(body);
  for (const personId of people) assert.ok(!text.includes(personId));
  for (const email of [a.user.email, mia.email]) assert.ok(!text.includes(email));
});

test("GET …/campaigns/funnel answers a Member her own campaigns without owner names, an Admin every one with them, and a Member without a campaign { asOf, campaigns: [] }", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const [admin, mia, idle] = [
    await member(ws, "Admin"),
    await member(ws, "Member"),
    await member(ws, "Member"),
  ];
  await campaign(ws, a.user.id, "Owner's");
  const miasCampaign = await campaign(ws, mia.id, "Mia's");
  await enroll(ws, miasCampaign, { steps: [sent("connect", 1, { acceptedAt: at(2) })] });

  assert.deepEqual(await read(mia.id, ws), {
    status: 200,
    body: {
      asOf: NOW,
      campaigns: [
        {
          ...{ campaignId: miasCampaign, name: "Mia's", status: "active" },
          ...numbers(1, [1, 1, 0, 0], [0, 0, 0], [0, 0]),
        },
      ],
    },
  });
  assert.deepEqual(await read(idle.id, ws), { status: 200, body: { asOf: NOW, campaigns: [] } });
  const { status, body } = await read(admin.id, ws);
  assert.equal(status, 200);
  const shown = (body.campaigns as { name: string; ownerName: string }[]).map(
    ({ name, ownerName }) => [name, ownerName],
  );
  assert.deepEqual(shown, [
    ["", a.user.displayName],
    ["Mia's", mia.displayName],
    ["Owner's", a.user.displayName],
  ]);
});

test("GET …/campaigns/funnel never counts another workspace's rows, those under the seeded campaign's key_ref and under this workspace's campaign id included", async () => {
  const [a, b] = await createTwoWorkspaces();
  const mine = await campaign(a.workspace.id, a.user.id, "Mine");
  const full = {
    ...replied("interested", 5),
    steps: [sent("connect", 1, { acceptedAt: at(2) }), emailed(3)],
  };
  for (const templateId of ["linkedin_default", mine])
    await enroll(b.workspace.id, templateId, full);
  await enroll(a.workspace.id, mine, { steps: [sent("connect", 1)] });

  type Answered = ReturnType<typeof numbers> & { readonly name: string };
  const numbersOf = async (userId: string, workspaceId: string) => {
    const { body } = await read(userId, workspaceId);
    return (body.campaigns as Answered[]).map(({ name, enrolled, linkedin, email, total }) => ({
      ...{ name, enrolled, linkedin, email, total },
    }));
  };
  assert.deepEqual(await numbersOf(a.user.id, a.workspace.id), [
    { name: "", ...NONE },
    { name: "Mine", ...numbers(1, [1, 0, 0, 0], [0, 0, 0], [0, 0]) },
  ]);
  assert.deepEqual(await numbersOf(b.user.id, b.workspace.id), [
    { name: "", ...numbers(1, [1, 1, 0, 0], [1, 1, 1], [1, 1]) },
  ]);
});

test("campaigns.read is required: a signed-in user who is no member of the workspace gets 403", async () => {
  const [a] = await createTwoWorkspaces();
  const nobody = await createUser();
  assert.deepEqual(await read(nobody.id, a.workspace.id), {
    status: 403,
    body: { code: "forbidden" },
  });
});
