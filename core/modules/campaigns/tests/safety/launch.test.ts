// The safety cases of the launch (gamma-p3-050; README.md "Launch checks"; beta, "rules we keep"),
// run by `pnpm -F campaigns test:safety`, on the worktree's database in this file's schema, each
// call in a tenant run as `app`, the credits on a fake client whose balance a test sets: no campaign
// becomes active with a failing check, each failing alone; a check flipped after the screen's read
// refuses the launch, which reads every check again under the campaign's lock; and a campaign that
// left `draft` is never launched again, two launches at once included. A draft becomes active only
// through launchCampaign: a resume refuses it.
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import {
  createConnectedAccount,
  setAccountPaused,
  setHealth,
  useLinkedinClient,
} from "@whytide/linkedin/testing";
import { bindCreditsClient } from "@whytide/platform";
import {
  createMembership,
  createOrganizationWithWorkspace,
  createUser,
} from "@whytide/tenancy/testing";
import { createCampaign, seedCampaign } from "../../domain/campaigns/commands.ts";
import { launchCampaign, launchChecks } from "../../domain/launch/launch.ts";
import { pauseCampaign, resumeCampaign } from "../../domain/pause/campaign.ts";
import { fixture } from "../fixtures.ts";

withTestDb();
useLinkedinClient(asRole("app"));
const WORKSPACE = "wsp_campaigns_launch_safety";
const { app, run } = fixture(WORKSPACE);
/** A send's price, and the balance the fake answers: one send's worth unless a test lowers it. */
const PRICE = "1";
let available = PRICE;
bindCreditsClient({
  balance: async () => {
    return { available, granted: available, reserved: "0", committed: "0", periodEnd: null };
  },
  priceOf: async (action) => ({ action, credits: PRICE, unit: "send", version: 1 }),
  reserve: () => Promise.reject(new Error("the launch reserves nothing")),
  commit: () => Promise.reject(new Error("the launch commits nothing")),
  release: () => Promise.reject(new Error("the launch releases nothing")),
});
beforeEach(() => {
  available = PRICE;
});

const PASSING = [
  { check: "linkedin_sender", ok: true, code: null },
  { check: "sending_disclosure", ok: true, code: null },
  { check: "credits", ok: true, code: null },
];
/** The checks with the ones named failing on their codes. */
const failing = (codes: Record<string, string>) =>
  PASSING.map((row) => (row.check in codes ? { ...row, ok: false, code: codes[row.check] } : row));

let owners = 0;
/** A draft campaign of a new owner, who has a connected account unless `account` is false. */
async function draft(options: { account?: boolean; disclosed?: boolean } = {}) {
  const ownerUserId = `usr_launch_owner_${++owners}`;
  const { account = true, disclosed = true } = options;
  const accountId = account
    ? (await createConnectedAccount(WORKSPACE, { ownerUserId, personalAccount: disclosed })).id
    : null;
  const input = { name: `Launch ${owners}`, ownerUserId, createdBy: ownerUserId };
  const { campaignId } = await run(() => createCampaign(input));
  return { campaignId, accountId: accountId ?? "" };
}

const campaignRow = async (id: string) => {
  const { status, launchedAt } = await app().campaign.findUniqueOrThrow({ where: { id } });
  return { status, launchedAt };
};
const DRAFT = { status: "draft", launchedAt: null };
/** The launch refused with campaign_launch_blocked and the checks it read. */
const blocked = (checks: unknown) => ({ code: "campaign_launch_blocked", details: { checks } });

test("no campaign becomes active with a failing check: each failing alone refuses the launch with campaign_launch_blocked and its checks, the campaign left a draft", async () => {
  const cases = [
    {
      // No connected account: no disclosure accepted either.
      made: await draft({ account: false }),
      checks: failing({
        linkedin_sender: "no_linkedin_sender",
        sending_disclosure: "disclosure_required",
      }),
    },
    {
      made: await draft(),
      flip: (accountId: string) => setHealth(accountId, "restricted"),
      checks: failing({ linkedin_sender: "linkedin_sender_unhealthy" }),
    },
    {
      made: await draft(),
      flip: (accountId: string) => setAccountPaused(accountId, "tester"),
      checks: failing({ linkedin_sender: "linkedin_sender_unhealthy" }),
    },
    {
      made: await draft({ disclosed: false }),
      checks: failing({ sending_disclosure: "disclosure_required" }),
    },
    {
      made: await draft(),
      flip: async () => {
        available = "0.99";
      },
      checks: failing({ credits: "insufficient_credits" }),
    },
  ];
  for (const { made, flip, checks } of cases) {
    available = PRICE;
    await flip?.(made.accountId);
    assert.deepEqual(await run(() => launchChecks(made.campaignId)), checks);
    await assert.rejects(
      run(() => launchCampaign(made.campaignId)),
      blocked(checks),
    );
    assert.deepEqual(await campaignRow(made.campaignId), DRAFT);
  }
});

test("a check flipped after the screen's read refuses the launch: the account restricted, then the balance spent; with every check passing again, the launch makes the draft active", async () => {
  const { campaignId, accountId } = await draft();
  assert.deepEqual(await run(() => launchChecks(campaignId)), PASSING, "the screen's read");
  await setHealth(accountId, "restricted");
  const unhealthy = failing({ linkedin_sender: "linkedin_sender_unhealthy" });
  await assert.rejects(
    run(() => launchCampaign(campaignId)),
    blocked(unhealthy),
  );
  assert.deepEqual(await campaignRow(campaignId), DRAFT);

  await setHealth(accountId, "healthy");
  assert.deepEqual(await run(() => launchChecks(campaignId)), PASSING, "read again");
  available = "0";
  const spent = failing({ credits: "insufficient_credits" });
  await assert.rejects(
    run(() => launchCampaign(campaignId)),
    blocked(spent),
  );
  assert.deepEqual(await campaignRow(campaignId), DRAFT);

  available = PRICE;
  const launched = await run(() => launchCampaign(campaignId));
  assert.deepEqual(await campaignRow(campaignId), {
    status: "active",
    launchedAt: launched.launchedAt,
  });
});

test("a campaign that left draft is never launched again: a second launch, two at once and the seeded campaign are campaign_not_draft; a draft is not resumed into active", async () => {
  const first = await draft();
  const launched = await run(() => launchCampaign(first.campaignId));
  assert.equal(launched.status, "active");
  const notDraft = { code: "campaign_not_draft" };
  await assert.rejects(
    run(() => launchCampaign(first.campaignId)),
    notDraft,
  );
  assert.deepEqual(await campaignRow(first.campaignId), {
    status: "active",
    launchedAt: launched.launchedAt,
  });
  // Paused, then still not a draft.
  await run(() => pauseCampaign(first.campaignId, { reason: "user" }));
  await assert.rejects(
    run(() => launchCampaign(first.campaignId)),
    notDraft,
  );

  // Two launches at once: the campaign's lock queues the second, which reads it active.
  const second = await draft();
  const both = await Promise.allSettled([
    run(() => launchCampaign(second.campaignId)),
    run(() => launchCampaign(second.campaignId)),
  ]);
  const outcomes = both.map((each) =>
    each.status === "fulfilled" ? "launched" : (each.reason as { code?: string }).code,
  );
  assert.deepEqual(outcomes.sort(), ["campaign_not_draft", "launched"]);

  // The seeded campaign is active from its first read, owned by the workspace's Owner.
  await createOrganizationWithWorkspace({ workspaceId: WORKSPACE });
  const { id: owner } = await createUser();
  await createMembership({ userId: owner, workspaceId: WORKSPACE, role: "Owner" });
  await createConnectedAccount(WORKSPACE, { ownerUserId: owner });
  const seeded = await run(() => seedCampaign());
  assert.equal(seeded?.status, "active");
  await assert.rejects(
    run(() => launchCampaign(seeded?.id ?? "")),
    notDraft,
  );

  const third = await draft();
  await assert.rejects(
    run(() => resumeCampaign(third.campaignId)),
    {
      code: "campaign_not_paused",
    },
  );
  assert.deepEqual(await campaignRow(third.campaignId), DRAFT);
});
