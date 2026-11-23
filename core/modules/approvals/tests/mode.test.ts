// The campaign's mode's approval (gamma-p4-090), in tenant runs as campaigns and the subscriber
// call it, against the worktree's database: at the open and at the attach, a redelivery, a person's
// decision of an item opened for the mode, the cancel; the stats and the day counts without the
// mode's approvals; the table's CHECKs on the decision, the wait and the sender; the mode taken back
// (returnModeItems, gamma-p4-070). The line, the default refusal and what the mode never approves
// are the safety suite's (tests/safety/mode-approval.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { useTenancyClient } from "@whytide/tenancy/testing";
import { cancelItems, returnModeItems } from "../domain/items/cancel.ts";
import { approve, skip } from "../domain/items/decide.ts";
import { decisionDays, editStats } from "../domain/items/queries.ts";
import { readQueue } from "../domain/items/queue.ts";
import { createApprovalItem } from "../testing/index.ts";
import {
  decisions,
  deliverDraftEnd,
  draftOf,
  EDITED,
  endDraft,
  itemOf,
  open,
  readyEmail,
  readyItem,
  run,
  seed,
  stepId,
} from "./fixtures/items.ts";

withTestDb();
useTenancyClient(asRole("app"));
useLinkedinClient(asRole("app"));

const mode = { approvalBy: "mode" as const };
/** check_violation: a CHECK of the table refused the row. */
const CHECK = "23514";

test("at the open and at the attach: a step opened again for the mode after a block, its draft ready already, is approved by the mode in the open's run; a redelivery of the draft's end changes nothing; one approvals.item_decided", async () => {
  const seeded = await seed();
  const { workspaceId } = seeded;
  const blocked = await open(seeded, mode);
  await run(workspaceId, () => cancelItems([blocked.stepExecutionId]));
  const draftId = await endDraft(workspaceId, blocked.stepExecutionId);
  assert.equal((await itemOf(workspaceId, blocked.approvalItemId)).status, "blocked");
  const reopened = await open(seeded, { ...mode, stepExecutionId: blocked.stepExecutionId });
  const row = await itemOf(workspaceId, reopened.approvalItemId);
  assert.deepEqual(
    [row.status, row.draftId, row.decisionOrigin, row.decidedBy],
    ["approved", draftId, "approval_mode", null],
  );
  const { stepExecutionId } = blocked;
  await deliverDraftEnd(workspaceId, { draftId, stepExecutionId, status: "ready" });
  assert.deepEqual(await itemOf(workspaceId, reopened.approvalItemId), row);
  const again = await open(seeded, { ...mode, stepExecutionId });
  assert.equal(again.approvalItemId, reopened.approvalItemId);
  const decided = { approvalItemId: reopened.approvalItemId, stepExecutionId };
  assert.deepEqual(await decisions(workspaceId), [{ ...decided, decision: "approved" }]);
});

test("a person decides an item opened for the mode while it is pending: an approval or a skip clears mode_declined and is the person's; a cancel blocks it and clears it too", async () => {
  const seeded = await seed();
  const { workspaceId, ownerId } = seeded;
  const declined = async () => {
    const opened = await open(seeded, mode);
    await endDraft(workspaceId, opened.stepExecutionId, "flagged");
    assert.equal((await itemOf(workspaceId, opened.approvalItemId)).waitCode, "mode_declined");
    return opened;
  };
  const [approved, skipped, blocked] = [await declined(), await declined(), await declined()];
  const text = { text: EDITED };
  await run(workspaceId, () => approve(approved.approvalItemId, text, seeded.asOwner));
  await run(workspaceId, () => skip(skipped.approvalItemId, seeded.asOwner));
  await run(workspaceId, () => cancelItems([blocked.stepExecutionId]));
  const rows = await Promise.all(
    [approved, skipped, blocked].map(({ approvalItemId }) => itemOf(workspaceId, approvalItemId)),
  );
  assert.deepEqual(
    rows.map((row) => [
      row.status,
      row.waitCode,
      row.decidedBy,
      row.decisionOrigin,
      row.approvalBy,
    ]),
    [
      ["approved", null, ownerId, "app", "mode"],
      ["skipped", null, ownerId, "app", "mode"],
      ["blocked", null, null, null, "mode"],
    ],
  );
});

test("editStats, decisionDays and the queue's decided today count a person's decisions only: the mode's approvals, LinkedIn and email, are left out", async () => {
  const seeded = await seed();
  const { workspaceId, accountId } = seeded;
  const since = new Date(Date.now() - 60_000);
  await readyItem(seeded, mode);
  await readyEmail(seeded, mode);
  const empty = { approved: 0, unedited: 0, smallEdits: 0 };
  assert.deepEqual(await run(workspaceId, () => editStats({ since })), empty);
  assert.deepEqual(await run(workspaceId, () => decisionDays({ since })), []);
  const queue = await run(workspaceId, () => readQueue(seeded.asOwner));
  assert.deepEqual(queue.counts, { toApprove: 0, decidedToday: 0 });

  const person = await readyItem(seeded);
  await run(workspaceId, () => approve(person.approvalItemId, {}, seeded.asOwner));
  const stats = await run(workspaceId, () => editStats({ since }));
  assert.deepEqual(stats, { approved: 1, unedited: 1, smallEdits: 0 });
  const days = await run(workspaceId, () => decisionDays({ since }));
  assert.deepEqual(
    days.map(({ senderAccountId, decisions }) => [senderAccountId, decisions]),
    [[accountId, 1]],
  );
  const after = await run(workspaceId, () => readQueue(seeded.asOwner));
  assert.deepEqual(after.counts, { toApprove: 0, decidedToday: 1 });
});

test("the CHECKs: the mode's origin with a decided_by, a person's decision without one, the mode's origin on a skip, on an item opened for a person or on an invite, mode_declined on a person's item, with a time or as another wait, an email without its mailbox or with an account, a message with a mailbox: each refused", async () => {
  const seeded = await seed();
  const { workspaceId, personId, accountId } = seeded;
  const linkedin = { workspaceId, personId, senderAccountId: accountId };
  const item = (columns: Record<string, unknown>) =>
    createApprovalItem({ ...linkedin, stepExecutionId: stepId(), ...columns });
  const update = (id: string, data: Record<string, unknown>) =>
    asRole("app").approvalItem.update({ where: { id }, data });

  const byMode = await item({ status: "approved", decisionOrigin: "approval_mode" });
  const byPerson = await item({ status: "approved" });
  assert.equal(await sqlstate(update(byMode, { decidedBy: seeded.ownerId })), CHECK, "mode by");
  assert.equal(await sqlstate(update(byPerson, { decidedBy: null })), CHECK, "person, no one");
  const asMode = { decisionOrigin: "approval_mode", decidedBy: null };
  assert.equal(await sqlstate(update(byPerson, asMode)), CHECK, "on a person's item");
  const modeOrigin = { decisionOrigin: "approval_mode", approvalBy: "mode" };
  assert.equal(await sqlstate(item({ status: "skipped", ...modeOrigin })), CHECK, "a skip");
  const invite = { stepKey: "connect", status: "approved", ...modeOrigin };
  assert.equal(await sqlstate(item(invite)), CHECK, "an invite");

  const declined = { approvalBy: "mode", waitCode: "mode_declined" };
  assert.equal(await sqlstate(item({ waitCode: "mode_declined" })), CHECK, "a person's");
  assert.equal(await sqlstate(item({ ...declined, waitUntil: new Date() })), CHECK, "a time");
  const credits = { approvalBy: "mode", waitCode: "insufficient_credits" };
  assert.equal(await sqlstate(item(credits)), CHECK, "another wait");
  assert.equal(await sqlstate(item(declined)), undefined, "mode_declined, pending");

  const email = { workspaceId, personId, stepExecutionId: stepId(), actionType: "email" as const };
  assert.equal(await sqlstate(createApprovalItem(email)), CHECK, "no mailbox");
  const withAccount = { ...email, senderAccountId: accountId };
  assert.equal(await sqlstate(createApprovalItem(withAccount)), CHECK, "an account");
  const both = { ...withAccount, mailboxId: "mbx_test" };
  assert.equal(await sqlstate(createApprovalItem(both)), CHECK, "both");
  const message = { mailboxId: "mbx_test", actionType: "message" };
  assert.equal(await sqlstate(item(message)), CHECK, "a message's mailbox");
  const mailboxOnly = { ...email, mailboxId: "mbx_test" };
  assert.equal(await sqlstate(createApprovalItem(mailboxOnly)), undefined, "an email");
});

test("returnModeItems: the steps' items opened for the mode, pending or approved by it, blocked, the approval's hash, time and origin cleared, the draft ready again without the line; a person's approval stays; a repeat blocks nothing", async () => {
  const seeded = await seed();
  const { workspaceId } = seeded;
  const byMode = await readyItem(seeded, mode);
  const pending = await open(seeded, mode);
  const person = await readyItem(seeded);
  await run(workspaceId, () => approve(person.approvalItemId, {}, seeded.asOwner));
  const opened = [byMode, pending, person];
  const steps = opened.map(({ stepExecutionId }) => stepExecutionId);
  const returned = await run(workspaceId, () => returnModeItems(steps));
  assert.deepEqual(new Set(returned), new Set(steps.slice(0, 2)));
  const rows = await Promise.all(
    opened.map(({ approvalItemId }) => itemOf(workspaceId, approvalItemId)),
  );
  assert.deepEqual(
    rows.map((row) => [row.status, row.approvedContentHash, row.decidedAt, row.decisionOrigin]),
    [
      ["blocked", null, null, null],
      ["blocked", null, null, null],
      ["approved", rows[2]?.approvedContentHash, rows[2]?.decidedAt, "app"],
    ],
  );
  assert.ok(rows[2]?.approvedContentHash, "a person's approval keeps its hash");
  const draft = await draftOf(workspaceId, byMode.stepExecutionId);
  assert.deepEqual([draft.status, draft.editedText], ["ready", null]);
  assert.equal((await draftOf(workspaceId, person.stepExecutionId)).status, "approved");
  assert.deepEqual(await run(workspaceId, () => returnModeItems(steps)), []);
});
