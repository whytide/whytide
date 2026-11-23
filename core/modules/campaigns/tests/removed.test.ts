// A removed member (gamma-p6-040; README.md "A removed member"; docs/flows.md "A removed member"):
// the subscriber to tenancy.member_removed's body on a schema of the worktree's database, in a
// tenant run as the delivery's. The removed user's enrollments end, those of the campaigns they own
// and those sending from their account (beta's, made with the approver's account), each `exited`
// (`no_sender`, owner_removed) with its pending steps cancelled, their items blocked and the lead
// finished; another member's are left alone, an `executing` step is left to the gate, and a
// redelivery changes nothing.
import assert from "node:assert/strict";
import test from "node:test";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { createConnectedAccount, useLinkedinClient } from "@whytide/linkedin/testing";
import { createMembership, createUser } from "@whytide/tenancy/testing";
import { createCampaign } from "../domain/campaigns/commands.ts";
import { endRemovedEnrollments } from "../domain/removed.ts";
import { APPROVER, type Enrolled, fixture } from "./fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
const WORKSPACE = "wsp_campaigns_removed";
const f = fixture(WORKSPACE);
const { app, run, account, enrolledLead, enrollmentOf, stepsOf, leadOf, moveStep } = f;
const removed = (userId: string) => run((tx) => endRemovedEnrollments(tx, userId, new Date()));

/** A Member of the workspace with a connected account; the user's id and the account's. */
async function member(): Promise<{ userId: string; accountId: string }> {
  const { id: userId } = await createUser();
  await createMembership({ userId, workspaceId: WORKSPACE, role: "Member" });
  const { id: accountId } = await createConnectedAccount(WORKSPACE, { ownerUserId: userId });
  return { userId, accountId };
}

/** The steps of the lead as `key:status:reason`, the reason a skip's or none. */
const statesOf = async (lead: Enrolled) =>
  (await stepsOf(lead.personId)).map(
    ({ stepKey, status, skipReason }) => `${stepKey}:${status}:${skipReason ?? "-"}`,
  );

test("the removed user's enrollments end, those of their campaigns and those sending from their account: no_sender, owner_removed, the pending steps cancelled and the lead finished; another member's left alone; a redelivery changes nothing", async () => {
  const ownersAccount = await account();
  const { userId, accountId } = await member();
  // An enrollment moved into the member's campaign, as routing would have made it, one of beta's
  // made with the member's account, and the Owner's own.
  const campaign = await run(() =>
    createCampaign({ name: "Member's", ownerUserId: userId, createdBy: userId }),
  );
  const { keyRef } = await app().campaign.findUniqueOrThrow({ where: { id: campaign.campaignId } });
  const inMembers = await enrolledLead("removed-campaign");
  await app().enrollment.update({
    where: { id: inMembers.enrollmentId },
    data: { templateId: keyRef },
  });
  await app().stepExecution.updateMany({
    where: { enrollmentId: inMembers.enrollmentId },
    data: { templateId: keyRef },
  });
  const fromAccount = await enrolledLead("removed-account");
  await app().enrollment.update({
    where: { id: fromAccount.enrollmentId },
    data: { senderAccountId: accountId },
  });
  await app().stepExecution.updateMany({
    where: { enrollmentId: fromAccount.enrollmentId, actionType: { not: "email" } },
    data: { senderAccountId: accountId },
  });
  const owners = await enrolledLead("removed-other");
  assert.equal(
    (await app().enrollment.findUniqueOrThrow({ where: { id: owners.enrollmentId } }))
      .senderAccountId,
    ownersAccount.id,
  );

  assert.equal(await removed(userId), 2);
  for (const lead of [inMembers, fromAccount]) {
    const { status, exitReason, exitDetail, endedAt } = await enrollmentOf(lead.enrollmentId);
    assert.deepEqual([status, exitReason, exitDetail], ["exited", "no_sender", "owner_removed"]);
    assert.ok(endedAt);
    for (const state of await statesOf(lead)) {
      assert.match(state, /:cancelled:owner_removed$/);
    }
    assert.equal((await leadOf(lead.personId)).status, "finished");
  }
  assert.equal((await enrollmentOf(owners.enrollmentId)).status, "active");
  assert.ok((await statesOf(owners)).every((state) => state.endsWith(":-")));

  // A redelivery: no live enrollment of the user's is left.
  const before = await app().stepExecution.findMany({ orderBy: { id: "asc" } });
  assert.equal(await removed(userId), 0);
  assert.deepEqual(await app().stepExecution.findMany({ orderBy: { id: "asc" } }), before);
});

test("a pending item of the removed user's enrollment is blocked; an executing step is left to the gate, and the enrollment ends around it", async () => {
  await account();
  const { userId, accountId } = await member();
  const lead = await enrolledLead("removed-executing");
  await app().enrollment.update({
    where: { id: lead.enrollmentId },
    data: { senderAccountId: accountId },
  });
  await app().stepExecution.updateMany({
    where: { enrollmentId: lead.enrollmentId, actionType: { not: "email" } },
    data: { senderAccountId: accountId },
  });
  await moveStep(lead.steps.connect, "succeeded");
  await moveStep(lead.steps.message_1, "executing");
  const queued = await enrolledLead("removed-pending");
  await app().enrollment.update({
    where: { id: queued.enrollmentId },
    data: { senderAccountId: accountId },
  });
  await app().stepExecution.updateMany({
    where: { enrollmentId: queued.enrollmentId, actionType: { not: "email" } },
    data: { senderAccountId: accountId },
  });
  assert.equal(await f.queue(queued.steps.connect), "opened");
  // The member removed between the queue's run and the delivery: the queue opened the item first.
  await app().membership.updateMany({
    where: { workspaceId: WORKSPACE, userId },
    data: { removedAt: new Date(), removedBy: APPROVER },
  });

  assert.equal(await removed(userId), 2);
  const states = await statesOf(lead);
  assert.deepEqual(states.slice(0, 2), ["connect:succeeded:-", "message_1:executing:-"]);
  assert.ok(states.slice(2).every((state) => state.endsWith(":cancelled:owner_removed")));
  assert.equal((await enrollmentOf(lead.enrollmentId)).exitDetail, "owner_removed");
  assert.equal((await f.itemOf(queued.steps.connect))?.status, "blocked");
  assert.equal(await removed(userId), 0);
});
