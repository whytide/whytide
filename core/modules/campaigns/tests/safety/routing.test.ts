// The safety cases of routing (gamma-p3-065; README.md "Agents' campaigns", "Enrolling"; beta, "rules
// we keep"), run by `pnpm -F campaigns test:safety`, on the worktree's database in this file's
// schema, through the outbox as the worker delivers it, sending open, the clocks on a Tuesday morning
// inside the account's hours: an agent's creation makes its one draft campaign; a lead found by the
// agent's source is enrolled into that campaign only, and nothing of it is opened in the queue, placed
// by the plan or claimed by the sender while the campaign is a draft; launched, the same steps go on;
// and a lead with no signal source, or whose source no agent holds, joins the seeded campaign.
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  events as contacts,
  createLeadForPerson,
  recordLeadStatus,
  upsertPersonFromSource,
} from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { createOutboxStore, outboxWriter, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import {
  openSending,
  useLinkedinClient,
  useClock as useLinkedinClock,
  useRandom as useLinkedinRandom,
} from "@whytide/linkedin/testing";
import {
  collectLogs,
  createLogger,
  deliverPending,
  type EventName,
  publish,
  servicePrincipal,
} from "@whytide/platform";
import { events as playbooks } from "@whytide/playbooks";
import { createPlaybook } from "@whytide/playbooks/testing";
import { SEEDED_CAMPAIGN_KEY } from "../../domain/campaigns/constants.ts";
import { planAccount } from "../../domain/plan/account.ts";
import { dueStepIds } from "../../domain/queue/due.ts";
import { claimStep } from "../../domain/send/claim.ts";
import { nextStep } from "../../domain/send/next.ts";
import "../../events.ts";
import { setCampaignActive, useClock, useRandom } from "../../testing/index.ts";
import { APPROVER, fixture } from "../fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
// A Tuesday, 10:00 UTC, inside the account's hours (09:00 to 18:00): the plan's clock and linkedin's.
const AT = new Date("2026-11-03T10:00:00Z");
useClock(() => AT);
useLinkedinClock(() => AT);
useRandom(() => 0.5);
useLinkedinRandom(() => 0.999);
// Sending open, as the operator opens it (beta-p1-040): a fresh database has it closed.
beforeEach(() => openSending());
const WORKSPACE = "wsp_campaigns_routing_safety";
const f = fixture(WORKSPACE);
const { app, run, account, queue } = f;
const HOUR_MS = 3_600_000;
/** The agent's signal source, and one no agent holds. */
const SOURCE = "src_routing_agent";
const FREE_SOURCE = "src_routing_free";
const log = createLogger({ destination: collectLogs().destination });

/** The approver the workspace's Owner, whom the seeded campaign is owned by; its account. */
async function ownedWorkspace(): Promise<{ accountId: string }> {
  await f.owned();
  return { accountId: (await account()).id };
}

/** The event in the outbox, then one pass of the worker's delivery, every event delivered. */
async function delivered<T>(event: EventName<T>, payload: T): Promise<void> {
  await run((tx) => publish(outboxWriter(tx, WORKSPACE), event, payload));
  const report = await deliverPending({
    store: createOutboxStore(app()),
    runInTenant: (workspaceId, fn) =>
      withTenant({ workspaceId, principal: servicePrincipal("worker") }, fn, { client: app() }),
    log,
  });
  const { claimed, delivered, ...failed } = report;
  assert.deepEqual([delivered, failed], [claimed, { retried: 0, dead: 0, deferred: 0 }]);
}

/** An agent of the approver's holding SOURCE, its creation delivered as playbooks publishes it. */
async function agent(name: string): Promise<string> {
  const icpId = "icp_routing";
  const seeded = { workspaceId: WORKSPACE, icpId, ownerUserId: APPROVER, name };
  const playbookId = await createPlaybook({ ...seeded, sourceIds: [SOURCE] });
  const created = { playbookId, ownerUserId: APPROVER, icpId };
  await delivered(playbooks["playbooks.playbook_created"], created);
  return playbookId;
}

/** A person whose lead came from the sources given, approved, its approval delivered. */
async function approvedLead(
  slug: string,
  sources: readonly { kind: "signal" | "imported"; ref: string }[],
): Promise<string> {
  const personId = await run(async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    for (const source of sources) await createLeadForPerson({ personId: person.id, source });
    await recordLeadStatus(person.id, "approved", { actor: { type: "user", id: APPROVER } });
    return person.id;
  });
  await delivered(contacts["contacts.lead_approved"], { personId, approvedBy: APPROVER });
  return personId;
}

/** The person's enrollments as [campaign key_ref, version, status], and their steps by key. */
async function enrolled(personId: string) {
  const rows = await app().enrollment.findMany({ where: { personId } });
  const steps = await app().stepExecution.findMany({
    where: { personId },
    orderBy: { position: "asc" },
  });
  const ids = Object.fromEntries(steps.map(({ stepKey, id }) => [stepKey, id]));
  return {
    enrollments: rows.map(({ templateId, templateVersion, status }) => [
      ...[templateId, templateVersion, status],
    ]),
    keys: steps.map(({ stepKey, status, templateId }) => `${stepKey}:${status}:${templateId}`),
    ids: ids as Record<string, string>,
  };
}

const placedOf = async (id: string) => {
  const { status, scheduledFor, quotaDay, errorCode, attempt, creditUsageId } =
    await app().stepExecution.findUniqueOrThrow({ where: { id } });
  return { status, scheduledFor, quotaDay, errorCode, attempt, creditUsageId };
};

test("an agent's lead joins the agent's draft campaign only: nothing opened, placed or claimed until the launch, then the same steps go on", async () => {
  const { accountId } = await ownedWorkspace();
  const playbookId = await agent("Founders in fintech");
  const campaigns = await app().campaign.findMany({ where: { playbookId } });
  assert.deepEqual(
    campaigns.map(({ name, status, ownerUserId, createdBy }) => [
      name,
      status,
      ownerUserId,
      createdBy,
    ]),
    [["Founders in fintech", "draft", APPROVER, "system"]],
  );
  const [campaign] = campaigns;
  assert.ok(campaign);

  const personId = await approvedLead("routing-agent", [{ kind: "signal", ref: SOURCE }]);
  const { enrollments, keys, ids } = await enrolled(personId);
  assert.deepEqual(enrollments, [[campaign.keyRef, 1, "active"]], "the agent's campaign only");
  const warm = [
    "connect",
    "message_1",
    "follow_up_1",
    "follow_up_2",
    "email_1",
    "email_2",
    "email_3",
  ];
  assert.deepEqual(
    keys,
    warm.map((key) => `${key}:planned:${campaign.keyRef}`),
  );
  const { connect = "", message_1 = "" } = ids;

  // Not opened: the connection request due an hour ago, the queue lists and opens nothing of it.
  await f.dueAt(connect, new Date(AT.getTime() - HOUR_MS));
  assert.deepEqual(await run(() => dueStepIds(AT)), [], "the queue lists nothing");
  assert.equal(await queue(connect), "passed_over");
  assert.equal(await f.itemOf(connect), null, "no item");

  // Not placed: the step `scheduled`, as an approval would leave it, and the plan places nothing.
  await f.moveStep(connect, "scheduled");
  assert.equal((await run(() => planAccount(accountId, AT))).placed, 0, "the plan places nothing");

  // Not claimed: the step placed as no plan places it for a draft, and the sender's claim refused,
  // the step put back to wait, unplaced, the attempt not raised, no credits and no slot taken.
  const placed = { scheduledFor: AT, quotaDay: "2026-11-03" };
  await app().stepExecution.update({ where: { id: connect }, data: placed });
  const claim = await run(() => claimStep({ stepExecutionId: connect, scheduledFor: AT }, AT));
  assert.deepEqual(claim, { blocked: "campaign_not_active" });
  const waiting = { status: "scheduled", scheduledFor: null, quotaDay: null };
  assert.deepEqual(await placedOf(connect), {
    ...{ ...waiting, errorCode: "campaign_not_active" },
    ...{ attempt: 0, creditUsageId: null },
  });
  assert.equal(await app().senderQuotaReservation.count(), 0, "no slot");
  assert.equal((await run(() => nextStep(accountId, AT))).step, null, "the sender finds nothing");

  // Launched: the plan places the step, the sender's next reads it and the queue lists message_1.
  await setCampaignActive({ workspaceId: WORKSPACE, campaignId: campaign.id });
  assert.equal((await run(() => planAccount(accountId, AT))).placed, 1, "the plan places it");
  const { step: next } = await run(() => nextStep(accountId, AT));
  assert.equal(next?.stepExecutionId, connect, "the sender's next reads it");
  await f.dueAt(message_1, AT);
  assert.deepEqual(await run(() => dueStepIds(AT)), [message_1]);
});

test("a lead with no signal source, or whose source no agent holds, joins the seeded campaign, an agent there or not", async () => {
  await ownedWorkspace();
  await agent("Agent with a source");
  const imported = await approvedLead("routing-imported", [{ kind: "imported", ref: "imp_1" }]);
  const free = await approvedLead("routing-free", [{ kind: "signal", ref: FREE_SOURCE }]);
  const beta = ["connect", "message_1", "follow_up_1", "follow_up_2"];
  for (const personId of [imported, free]) {
    const { enrollments, keys } = await enrolled(personId);
    assert.deepEqual(enrollments, [[SEEDED_CAMPAIGN_KEY, 1, "active"]]);
    assert.deepEqual(
      keys,
      beta.map((key) => `${key}:planned:${SEEDED_CAMPAIGN_KEY}`),
    );
  }
  // The seeded campaign is active: its connection request, due, is opened.
  const { ids } = await enrolled(imported);
  await f.dueAt(ids.connect ?? "", new Date(AT.getTime() - HOUR_MS));
  assert.equal(await queue(ids.connect ?? ""), "opened");
});
