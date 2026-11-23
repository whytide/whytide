// The routing choice (gamma-p3-065; README.md "Enrolling", "Agents' campaigns"), run by `pnpm -F
// campaigns test`: the oldest source of kind `signal` decides, by its time and not its place, the
// earlier entry on a tie; then, on the worktree's database in this file's schema, each read in a
// tenant run as `app`, the agent holding that source and its campaign, a draft or a paused one
// included; no signal source, a source no agent holds, an agent without a campaign, or its campaign
// archived, none (the seeded campaign); and of two agents' sources, the oldest's agent.
import assert from "node:assert/strict";
import test from "node:test";
import { createLeadForPerson, type LeadSource, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { createPlaybook } from "@whytide/playbooks/testing";
import { createOrganizationWithWorkspace } from "@whytide/tenancy/testing";
import { createCampaign } from "../domain/campaigns/commands.ts";
import { oldestSignalSource, routedCampaign } from "../domain/enroll/route.ts";
import { APPROVER, fixture } from "./fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
const WORKSPACE = "wsp_campaigns_route";
const { run } = fixture(WORKSPACE);
const app = () => asRole("app");
const DAY_MS = 86_400_000;
const T0 = new Date("2026-11-02T09:00:00Z");
/** The instant `days` after T0, as contacts stores a source's. */
const day = (days: number) => new Date(T0.getTime() + days * DAY_MS);

const entry = (kind: LeadSource["kind"], ref: string, days: number): LeadSource => ({
  kind,
  ref,
  at: day(days).toISOString(),
});

test("the oldest source of kind signal decides, by its time, the earlier entry on a tie; none without one", () => {
  assert.equal(oldestSignalSource([]), null);
  assert.equal(
    oldestSignalSource([entry("imported", "imp_1", 0), entry("manual", "usr_1", 1)]),
    null,
  );
  const later = entry("signal", "src_later", 3);
  const older = entry("signal", "src_older", 2);
  assert.equal(oldestSignalSource([later, entry("imported", "imp_1", 0), older]), "src_older");
  const same = entry("signal", "src_same", 2);
  assert.equal(oldestSignalSource([older, same]), "src_older");
  assert.equal(oldestSignalSource([same, older]), "src_same");
});

/** A person whose lead came from the sources given, at the days given; its id. */
const leadFrom = (slug: string, sources: readonly [ref: string, days: number][]) =>
  run(async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    for (const [ref, days] of sources) {
      const kind = ref.startsWith("src_") ? "signal" : "imported";
      await createLeadForPerson({ personId: person.id, source: { kind, ref, at: day(days) } });
    }
    return person.id;
  });

/** An agent of its own audience holding the sources; with a campaign unless `campaign` is false. */
async function agentWith(
  icpId: string,
  sourceIds: readonly string[],
  campaign = true,
): Promise<{ playbookId: string; campaignId: string | null }> {
  const seeded = { workspaceId: WORKSPACE, icpId, ownerUserId: APPROVER, sourceIds };
  const playbookId = await createPlaybook(seeded);
  if (!campaign) return { playbookId, campaignId: null };
  const made = await run(() =>
    createCampaign({ name: icpId, ownerUserId: APPROVER, createdBy: "system", playbookId }),
  );
  return { playbookId, campaignId: made.campaignId };
}

/** The campaign routing chooses for the person, by its id; null for the seeded campaign. */
const routed = async (personId: string) => (await run(() => routedCampaign(personId)))?.id ?? null;

test("the agent holding the oldest signal source, and its campaign, a draft or a paused one; none for a source no agent holds, an agent without a campaign or an archived campaign", async () => {
  await createOrganizationWithWorkspace({ workspaceId: WORKSPACE });
  const held = await agentWith("icp_route_held", ["src_held"]);
  const bare = await agentWith("icp_route_bare", ["src_bare"], false);

  const draft = await leadFrom("route-draft", [
    ["imp_1", 0],
    ["src_held", 1],
  ]);
  assert.equal(await routed(draft), held.campaignId, "the draft, its enrollments waiting");
  assert.deepEqual(
    await run(async () => {
      const campaign = await routedCampaign(draft);
      return [campaign?.status, campaign?.playbookId, campaign?.currentVersionId !== null];
    }),
    ["draft", held.playbookId, true],
  );
  const pausedAt = new Date();
  const paused = { status: "paused", pausedReason: "user", pausedAt } as const;
  await app().campaign.update({ where: { id: held.campaignId ?? "" }, data: paused });
  assert.equal(await routed(draft), held.campaignId, "a paused one too");

  assert.equal(await routed(await leadFrom("route-imported", [["imp_1", 0]])), null);
  assert.equal(await routed(await leadFrom("route-free", [["src_free", 0]])), null);
  assert.equal(await routed(await leadFrom("route-bare", [["src_bare", 0]])), null);

  const archived = { status: "archived", pausedReason: null, pausedAt: null } as const;
  await app().campaign.update({ where: { id: held.campaignId ?? "" }, data: archived });
  assert.equal(await routed(draft), null, "an archived campaign: the seeded one");
});

test("of two agents' sources, the oldest's agent; a later source's agent is never asked", async () => {
  await createOrganizationWithWorkspace({ workspaceId: WORKSPACE });
  const first = await agentWith("icp_route_first", ["src_first"]);
  const second = await agentWith("icp_route_second", ["src_second"]);
  // Appended in arrival order, but the time decides: src_second came first here.
  const both = await leadFrom("route-both", [
    ["src_first", 2],
    ["src_second", 1],
  ]);
  assert.equal(await routed(both), second.campaignId);
  const later = await leadFrom("route-later", [
    ["src_first", 1],
    ["src_second", 2],
  ]);
  assert.equal(await routed(later), first.campaignId);
  // The oldest signal source no agent holds: the seeded campaign, though a later one's agent has one.
  const free = await leadFrom("route-free-first", [
    ["src_free", 0],
    ["src_first", 1],
  ]);
  assert.equal(await routed(free), null);
});
