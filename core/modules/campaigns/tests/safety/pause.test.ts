// The safety cases of pausing (gamma-p3-060; README.md "Pausing"; beta, "rules we keep"), run by
// `pnpm -F campaigns test:safety`, on the worktree's database in this file's schema, each call in a
// tenant run as `app`, sending open, the clocks on a Tuesday morning inside the account's hours: no
// step of a paused enrollment, or of a paused or draft campaign, is opened in the queue, placed by
// the plan or claimed by the sender; a pause after the plan placed a step blocks its claim and puts
// it back to wait, unplaced, with no credits and no slot taken; a resume lets the same steps go on;
// and a paused enrollment is still live for the stops: a reply holds it and a suppression exits it.
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { addOptOut } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import {
  openSending,
  useLinkedinClient,
  useClock as useLinkedinClock,
  useRandom as useLinkedinRandom,
} from "@whytide/linkedin/testing";
import { createCampaign, seedCampaign } from "../../domain/campaigns/commands.ts";
import { exitSuppressedEnrollments } from "../../domain/gate/suppressed.ts";
import { holdForReply } from "../../domain/hold.ts";
import { pauseCampaign, resumeCampaign } from "../../domain/pause/campaign.ts";
import { pauseEnrollment, resumeEnrollment } from "../../domain/pause/enrollment.ts";
import { planAccount } from "../../domain/plan/account.ts";
import { dueStepIds } from "../../domain/queue/due.ts";
import { claimStep } from "../../domain/send/claim.ts";
import { nextStep } from "../../domain/send/next.ts";
import { useClock, useRandom } from "../../testing/index.ts";
import { type Enrolled, fixture } from "../fixtures.ts";

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
const WORKSPACE = "wsp_campaigns_pause_safety";
const f = fixture(WORKSPACE);
const { app, run, account, enrolledLead, approved, queue, stepsOf, leadOf } = f;
const HOUR_MS = 3_600_000;

/** The approver the workspace's Owner, whom the seeded campaign is owned by; its account. */
async function ownedWorkspace(): Promise<{ owner: string; accountId: string }> {
  const owner = await f.owned();
  return { owner, accountId: (await account()).id };
}

/** A person enrolled, the connection request due an hour ago, approved and `scheduled`. */
async function scheduled(slug: string): Promise<Enrolled> {
  const lead = await enrolledLead(slug);
  await f.dueAt(lead.steps.connect, new Date(AT.getTime() - HOUR_MS));
  await approved(lead.steps.connect);
  return lead;
}

const placedOf = async (id: string) => {
  const { status, scheduledFor, quotaDay, errorCode, attempt, creditUsageId } =
    await app().stepExecution.findUniqueOrThrow({ where: { id } });
  return { status, scheduledFor, quotaDay, errorCode, attempt, creditUsageId };
};

/**
 * The person's connection request placed by the plan and read by the sender's `next`, then `stop`
 * (a pause) before the claim: the claim is blocked with `code` and the step put back to wait,
 * unplaced, the attempt not raised, no credits and no slot taken; while the stop lasts, the plan
 * places nothing, `next` finds nothing and the queue opens nothing of the enrollment.
 */
async function waitsOn(
  accountId: string,
  lead: Enrolled,
  stop: () => Promise<unknown>,
  code: string,
): Promise<void> {
  const { connect, message_1 } = lead.steps;
  assert.equal((await run(() => planAccount(accountId, AT))).placed, 1);
  const { step: next } = await run(() => nextStep(accountId, AT));
  assert.ok(next !== null && next.stepExecutionId === connect, "the sender's next reads it");
  await stop();
  const scheduledFor = new Date(next.scheduledFor);
  const claim = await run(() =>
    claimStep({ stepExecutionId: connect, scheduledFor }, scheduledFor),
  );
  assert.deepEqual(claim, { blocked: code });
  const waiting = { status: "scheduled", scheduledFor: null, quotaDay: null, errorCode: code };
  assert.deepEqual(await placedOf(connect), { ...waiting, attempt: 0, creditUsageId: null });
  assert.equal(await app().senderQuotaReservation.count(), 0, "no slot");
  assert.equal((await run(() => planAccount(accountId, AT))).placed, 0, "the plan places nothing");
  assert.equal((await run(() => nextStep(accountId, AT))).step, null, "the sender finds nothing");
  // message_1 due now, as an acceptance would leave it: the queue opens nothing.
  await f.dueAt(message_1, AT);
  assert.deepEqual(await run(() => dueStepIds(AT)), [], "the queue lists nothing");
  assert.equal(await queue(message_1), "passed_over");
  assert.equal(await f.itemOf(message_1), null);
}

/** After the resume: the plan places the step again, its code cleared, and the queue lists message_1. */
async function goesOn(accountId: string, lead: Enrolled): Promise<void> {
  assert.equal((await run(() => planAccount(accountId, AT))).placed, 1);
  const { errorCode, scheduledFor } = await placedOf(lead.steps.connect);
  assert.deepEqual([errorCode, scheduledFor !== null], [null, true]);
  assert.deepEqual(await run(() => dueStepIds(AT)), [lead.steps.message_1]);
}

test("a paused enrollment: nothing opened, placed or claimed, a placed step put back unplaced; resumed, the same steps go on", async () => {
  const { accountId } = await ownedWorkspace();
  const lead = await scheduled("pause-enrollment");
  const pause = () => run(() => pauseEnrollment(lead.enrollmentId, { reason: "user" }));
  await waitsOn(accountId, lead, pause, "enrollment_paused");
  await run(() => resumeEnrollment(lead.enrollmentId));
  await goesOn(accountId, lead);
});

test("a paused campaign: nothing of its enrollments opened, placed or claimed; resumed, the same steps go on", async () => {
  const { accountId } = await ownedWorkspace();
  const seeded = await run(() => seedCampaign());
  assert.ok(seeded);
  const lead = await scheduled("pause-campaign");
  const pause = () => run(() => pauseCampaign(seeded.id, { reason: "user" }));
  await waitsOn(accountId, lead, pause, "campaign_not_active");
  assert.equal((await f.enrollmentOf(lead.enrollmentId)).status, "active", "its enrollment stays");
  await run(() => resumeCampaign(seeded.id));
  await goesOn(accountId, lead);
});

test("a draft campaign: nothing of an enrollment in it opened, placed or claimed", async () => {
  const { owner, accountId } = await ownedWorkspace();
  const draft = await run(() =>
    createCampaign({ name: "Not launched", ownerUserId: owner, createdBy: owner }),
  );
  const lead = await scheduled("pause-draft");
  // No code enrolls anyone in a draft yet (gamma-p3-065 routes leads to campaigns): the rows of the
  // enrollment are moved onto it, after the plan placed its connection request.
  const moveToDraft = async () => {
    const onDraft = { templateId: draft.campaignId, templateVersion: draft.versionNo };
    await app().enrollment.update({ where: { id: lead.enrollmentId }, data: onDraft });
    const steps = { enrollmentId: lead.enrollmentId };
    await app().stepExecution.updateMany({ where: steps, data: onDraft });
  };
  await waitsOn(accountId, lead, moveToDraft, "campaign_not_active");
});

test("a paused enrollment is still live for the stops: a reply holds it, a suppression exits it", async () => {
  await ownedWorkspace();
  const pausedOf = async (id: string) => {
    const { status, exitReason, pausedReason, pausedUntil } =
      await app().enrollment.findUniqueOrThrow({ where: { id } });
    return { status, exitReason, pausedReason, pausedUntil };
  };
  const until = new Date(AT.getTime() + 48 * HOUR_MS);

  const replied = await scheduled("pause-reply");
  await run(() => pauseEnrollment(replied.enrollmentId, { reason: "user", until }));
  await run(() => holdForReply(replied.personId, { at: AT }));
  assert.deepEqual(
    (await stepsOf(replied.personId)).map(({ status }) => status),
    ["held", "held", "held", "held"],
  );
  const ended = { pausedReason: null, pausedUntil: null };
  assert.deepEqual(await pausedOf(replied.enrollmentId), {
    ...{ status: "replied", exitReason: null },
    ...ended,
  });
  assert.equal((await leadOf(replied.personId)).status, "replied");

  const suppressed = await scheduled("pause-opt-out");
  await run(() => pauseEnrollment(suppressed.enrollmentId, { reason: "out_of_office" }));
  await run(() => addOptOut(suppressed.personId, { source: "system", reason: "reply_opt_out" }));
  assert.equal(await run((tx) => exitSuppressedEnrollments(tx, AT)), 1);
  assert.deepEqual(
    (await stepsOf(suppressed.personId)).map(({ status, skipReason }) => [status, skipReason]),
    Array.from({ length: 4 }, () => ["cancelled", "opted_out"]),
  );
  assert.deepEqual(await pausedOf(suppressed.enrollmentId), {
    ...{ status: "exited", exitReason: "suppressed" },
    ...ended,
  });
  assert.equal((await leadOf(suppressed.personId)).status, "suppressed");
});
