// campaigns' counts route end to end (beta-p7-010; core/modules/campaigns/README.md "Routes"): the
// host started with identity and campaigns, on the fake authentication adapter, in a schema of the
// worktree's database, answering real HTTP, with campaigns' clock fixed (useClock). Per sender account
// of the workspace's enrollments, by label: each number on seeded rows; every other step status, a
// withdrawal and the enrollments that did not end on a reply left out; the periods' boundaries in two
// zones from the same instants; an account linkedin no longer holds, in UTC; another workspace's rows,
// the same sender id's included; campaigns.read; whose accounts, a Member's own or an Owner's every
// one (gamma-p6-070). The rows are written as campaigns and its sender leave them by campaigns'
// createEnrollment, the accounts by linkedin's factory. It lives here: a module never imports a host.
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
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
type Seeded = Parameters<CampaignsTesting["createEnrollment"]>[0];
const campaigns: Campaigns = await import(built("campaigns/dist"));
const testing: CampaignsTesting = await import(built("campaigns/dist/testing"));
const linkedin: LinkedinTesting = await import(built("linkedin/dist/testing"));

const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
linkedin.useLinkedinClient(app);
let api: Api;

/** The counts' now: 11:30 on Thursday 29 October in Kolkata, 23:00 on the 28th in Los Angeles. */
const NOW = "2026-10-29T06:00:00.000Z";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (days: number, hours = 0) => new Date(Date.parse(NOW) - days * DAY - hours * HOUR);

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

let persons = 0;
/** An enrollment of a new person from the account, with its steps; the person's id. */
async function enroll(workspaceId: string, senderAccountId: string, rest: Partial<Seeded> = {}) {
  const personId = `per_counts_${++persons}`;
  await testing.createEnrollment({ workspaceId, personId, senderAccountId, ...rest }, app);
  return personId;
}

/** A connected account in the zone, with the label, and its owner when given. */
async function account(workspaceId: string, timeZone: string, label: string, ownerUserId?: string) {
  const { id } = await linkedin.createConnectedAccount(workspaceId, { timeZone, ownerUserId });
  await app.senderAccount.update({ where: { id }, data: { label } });
  return id;
}

/** GET …/campaigns/counts of the workspace, signed in as the user. */
async function read(userId: string, workspaceId: string) {
  const cookie = signInAs(userId).map(({ name, value }) => `${name}=${value}`);
  const path = `/v1/workspaces/${workspaceId}/campaigns/counts`;
  const res = await fetch(new URL(path, api.url), { headers: { cookie: cookie.join("; ") } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

type Tally = [invitesSent: number, messagesSent: number, accepted: number, replied: number];
const tally = ([invitesSent, messagesSent, accepted, replied]: Tally) => ({
  ...{ invitesSent, messagesSent, accepted, replied },
});
const ZERO: Tally = [0, 0, 0, 0];
/** A sender as the route answers it. */
function sender(
  senderAccountId: string,
  [label, timeZone]: [string | null, string | null],
  [today, last7Days, sinceStart]: [Tally, Tally, Tally],
) {
  return {
    ...{ senderAccountId, label, timeZone },
    ...{ today: tally(today), last7Days: tally(last7Days), sinceStart: tally(sinceStart) },
  };
}

const sent = (stepKey: string, executedAt: Date, acceptedAt?: Date) =>
  ({ stepKey, status: "succeeded", executedAt, acceptedAt }) as const;
const held = (stepKey: string) => ({ stepKey, status: "held", skipReason: "replied" }) as const;

test("GET …/campaigns/counts answers each sender account by label with its connection requests and messages sent, invitations accepted and people who replied, today, over the last 7 days and since the start in its zone; an account linkedin no longer holds last, in UTC; ids, labels, zones and numbers only", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const sales = await account(workspaceId, "Asia/Kolkata", "Sales");
  const founder = await account(workspaceId, "America/Los_Angeles", "Founder");
  const people = [
    // Sent an hour ago, 10:30 in Kolkata, and accepted half an hour later.
    await enroll(workspaceId, sales, {
      steps: [sent("connect", ago(0, 1), ago(0, 0.5)), { stepKey: "message_1", status: "planned" }],
    }),
    // Sent 3 days ago, accepted 2 days ago; the first message a day ago, then the reply.
    await enroll(workspaceId, sales, {
      ...{ status: "replied", endedAt: ago(1) },
      steps: [
        sent("connect", ago(3), ago(2)),
        sent("message_1", ago(1, 2)),
        held("follow_up_1"),
        held("follow_up_2"),
      ],
    }),
    // The whole sequence: sent 20 days ago, the last follow-up 2 hours ago (09:30 in Kolkata).
    await enroll(workspaceId, sales, {
      ...{ status: "completed", endedAt: ago(0, 2) },
      steps: [
        sent("connect", ago(20), ago(19)),
        sent("message_1", ago(19)),
        sent("follow_up_1", ago(5)),
        sent("follow_up_2", ago(0, 2)),
      ],
    }),
    // Claimed and not settled yet, accepted meanwhile: an acceptance, not a send.
    await enroll(workspaceId, sales, {
      steps: [{ stepKey: "connect", status: "executing", acceptedAt: ago(0, 0.25) }],
    }),
    // A reply 30 days ago.
    await enroll(workspaceId, sales, {
      ...{ status: "replied", endedAt: ago(30) },
      steps: [sent("connect", ago(40), ago(39)), sent("message_1", ago(38)), held("follow_up_1")],
    }),
    // A reply today, 08:30 in Kolkata, to the first message sent at 07:30.
    await enroll(workspaceId, sales, {
      ...{ status: "replied", endedAt: ago(0, 3) },
      steps: [sent("connect", ago(10), ago(9)), sent("message_1", ago(0, 4)), held("follow_up_1")],
    }),
    // 01:00 on the 28th in Los Angeles: today there, the day before in Kolkata.
    await enroll(workspaceId, founder, {
      steps: [sent("connect", new Date("2026-10-28T08:00:00.000Z"))],
    }),
    // An account linkedin no longer holds: 00:30 UTC today.
    await enroll(workspaceId, "sac_counts_gone", {
      steps: [sent("connect", new Date("2026-10-29T00:30:00.000Z"))],
    }),
  ];
  // A refused enrollment names no sender: it adds none.
  await testing.createEnrollment(
    { workspaceId, personId: "per_counts_refused", senderAccountId: null, status: "exited" },
    app,
  );

  const { status, body } = await read(a.user.id, workspaceId);
  assert.equal(status, 200);
  assert.deepEqual(body, {
    asOf: NOW,
    scope: "all",
    senders: [
      sender(
        founder,
        ["Founder", "America/Los_Angeles"],
        [
          [1, 0, 0, 0],
          [1, 0, 0, 0],
          [1, 0, 0, 0],
        ],
      ),
      sender(
        sales,
        ["Sales", "Asia/Kolkata"],
        [
          [1, 2, 2, 1],
          [2, 4, 3, 2],
          [5, 6, 6, 3],
        ],
      ),
      sender(
        "sac_counts_gone",
        [null, null],
        [
          [1, 0, 0, 0],
          [1, 0, 0, 0],
          [1, 0, 0, 0],
        ],
      ),
    ],
  });
  // No person: not even an id.
  const text = JSON.stringify(body);
  for (const personId of [...people, "per_counts_refused"]) assert.ok(!text.includes(personId));
});

test("GET …/campaigns/counts counts no step planned, awaiting approval, scheduled, executing, failed, skipped, held or cancelled, no withdrawal, and no enrollment active, completed or exited, whatever their times", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const id = await account(workspaceId, "UTC", "Left out");
  const at = ago(0, 1);
  const statuses = [
    "planned",
    "awaiting_approval",
    "scheduled",
    "executing",
    "failed",
    "skipped",
    "held",
    "cancelled",
  ] as const;
  for (const status of statuses) {
    // A time on each, as a stale one could be: the status decides.
    const step = (stepKey: string) => ({ stepKey, status, executedAt: at });
    await enroll(workspaceId, id, { steps: [step("connect"), step("message_1")] });
  }
  // A withdrawal sent today: not a connection request.
  await enroll(workspaceId, id, {
    ...{ status: "exited", exitReason: "not_accepted", endedAt: at },
    steps: [
      { stepKey: "connect", status: "succeeded", executedAt: ago(21) },
      { stepKey: "withdraw", actionType: "withdraw", status: "succeeded", executedAt: at },
    ],
  });
  await enroll(workspaceId, id, { status: "completed", endedAt: at });
  await enroll(workspaceId, id, { status: "exited", exitReason: "suppressed", endedAt: at });

  const { status, body } = await read(a.user.id, workspaceId);
  assert.equal(status, 200);
  assert.deepEqual(body, {
    asOf: NOW,
    scope: "all",
    senders: [sender(id, ["Left out", "UTC"], [ZERO, ZERO, [1, 0, 0, 0]])],
  });
});

test("GET …/campaigns/counts reads each sender's periods in its zone: 23:30 local yesterday is in the last 7 days and not today, 00:10 local today is today, seven local days ago only since the start, the same instants counted differently in Kolkata and Los Angeles", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const kolkata = await account(workspaceId, "Asia/Kolkata", "Kolkata");
  const losAngeles = await account(workspaceId, "America/Los_Angeles", "Los Angeles");
  // Each as Kolkata's clock reads it, then Los Angeles's (PDT); now is 11:30 on the 29th in
  // Kolkata, 23:00 on the 28th in Los Angeles.
  const instants = [
    "2026-10-28T18:00:00.000Z", // 23:30 on the 28th, yesterday; 11:00 on the 28th, today
    "2026-10-28T18:40:00.000Z", // 00:10 on the 29th, today; 11:40 on the 28th, today
    "2026-10-28T06:30:00.000Z", // 12:00 on the 28th, yesterday; 23:30 on the 27th, yesterday
    "2026-10-28T07:10:00.000Z", // 12:40 on the 28th, yesterday; 00:10 on the 28th, today
    "2026-10-22T06:30:00.000Z", // 12:00 on the 22nd, 7 days ago; 23:30 on the 21st, 7 days ago
    "2026-10-22T18:30:00.000Z", // 00:00 on the 23rd, 6 days ago; 11:30 on the 22nd, 6 days ago
    "2026-10-22T07:00:00.000Z", // 12:30 on the 22nd, 7 days ago; 00:00 on the 22nd, 6 days ago
  ];
  for (const id of [kolkata, losAngeles]) {
    for (const instant of instants) {
      const at = new Date(instant);
      await enroll(workspaceId, id, {
        ...{ status: "replied", endedAt: at },
        steps: [sent("connect", at, at), sent("message_1", at)],
      });
    }
  }

  const { status, body } = await read(a.user.id, workspaceId);
  assert.equal(status, 200);
  const all = (n: number): Tally => [n, n, n, n];
  assert.deepEqual(body, {
    asOf: NOW,
    scope: "all",
    senders: [
      sender(kolkata, ["Kolkata", "Asia/Kolkata"], [all(1), all(5), all(7)]),
      sender(losAngeles, ["Los Angeles", "America/Los_Angeles"], [all(3), all(6), all(7)]),
    ],
  });
});

test("GET …/campaigns/counts never counts another workspace's rows, those under the same sender account id included; without an enrollment, no sender", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ofA = await account(a.workspace.id, "UTC", "A's");
  const ofB = await account(b.workspace.id, "UTC", "B's");
  assert.deepEqual(await read(a.user.id, a.workspace.id), {
    status: 200,
    body: { asOf: NOW, scope: "all", senders: [] },
  });
  await enroll(a.workspace.id, ofA, { steps: [sent("connect", ago(0, 1))] });
  // B's rows: its own account's, and rows under A's account id, which B's linkedin does not hold.
  for (const id of [ofB, ofA]) {
    await enroll(b.workspace.id, id, {
      ...{ status: "replied", endedAt: ago(0, 1) },
      steps: [sent("connect", ago(2), ago(1)), sent("message_1", ago(0, 2))],
    });
  }

  const both: [Tally, Tally, Tally] = [
    [0, 1, 0, 1],
    [1, 1, 1, 1],
    [1, 1, 1, 1],
  ];
  assert.deepEqual(await read(a.user.id, a.workspace.id), {
    status: 200,
    body: {
      asOf: NOW,
      scope: "all",
      senders: [
        sender(
          ofA,
          ["A's", "UTC"],
          [
            [1, 0, 0, 0],
            [1, 0, 0, 0],
            [1, 0, 0, 0],
          ],
        ),
      ],
    },
  });
  assert.deepEqual(await read(b.user.id, b.workspace.id), {
    status: 200,
    body: {
      asOf: NOW,
      scope: "all",
      senders: [sender(ofB, ["B's", "UTC"], both), sender(ofA, [null, null], both)],
    },
  });
});

test("campaigns.read is required: a signed-in user who is no member of the workspace gets 403", async () => {
  const [a] = await createTwoWorkspaces();
  const nobody = await createUser();
  assert.deepEqual(await read(nobody.id, a.workspace.id), {
    status: 403,
    body: { code: "forbidden" },
  });
});

test("whose accounts (gamma-p6-070): a Member reads their own account's counts alone, scope own, and the other Member theirs; an Owner every member's and an account linkedin no longer holds, scope all", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const [ada, bo] = [await createUser(), await createUser()];
  for (const { id: userId } of [ada, bo]) {
    await createMembership({ userId, workspaceId: ws, role: "Member" });
  }
  const adas = await account(ws, "UTC", "Ada's", ada.id);
  const bos = await account(ws, "UTC", "Bo's", bo.id);
  const gone = "sac_counts_gone";
  for (const id of [adas, bos, gone]) {
    await enroll(ws, id, { steps: [sent("connect", ago(0, 1))] });
  }
  const one: [Tally, Tally, Tally] = [
    [1, 0, 0, 0],
    [1, 0, 0, 0],
    [1, 0, 0, 0],
  ];
  const own = (senders: unknown[]) => ({ status: 200, body: { asOf: NOW, scope: "own", senders } });
  assert.deepEqual(await read(ada.id, ws), own([sender(adas, ["Ada's", "UTC"], one)]));
  assert.deepEqual(await read(bo.id, ws), own([sender(bos, ["Bo's", "UTC"], one)]));
  const senders = [
    sender(adas, ["Ada's", "UTC"], one),
    sender(bos, ["Bo's", "UTC"], one),
    sender(gone, [null, null], one),
  ];
  assert.deepEqual(await read(a.user.id, ws), {
    status: 200,
    body: { asOf: NOW, scope: "all", senders },
  });
});
