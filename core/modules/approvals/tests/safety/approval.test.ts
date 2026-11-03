// The safety suite's approval cases (beta's rules we keep: nothing goes out that its sender
// account's owner did not approve; docs/security.md): approvedContent answers a step's text only
// for an item the account's owner approved, and only while messaging's frozen text hashes to the
// approval's hash; a blocked item is never approved; a decision applies once, two presses at once
// included, with one approvals.item_decided.
import assert from "node:assert/strict";
import { test } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { approveStepDraft } from "@whytide/messaging";
import { createStepDraft } from "@whytide/messaging/testing";
import { useTenancyClient } from "@whytide/tenancy/testing";
import { cancelItems } from "../../domain/items/cancel.ts";
import { approve, skip } from "../../domain/items/decide.ts";
import { approvedContent } from "../../domain/items/queries.ts";
import { createApprovalItem } from "../../testing/index.ts";
import {
  decisions,
  draftOf,
  EDITED,
  itemOf,
  readyItem,
  run,
  type Seeded,
  seed,
  sha256,
  stepId,
  TEXT,
} from "../fixtures/items.ts";

withTestDb();
useTenancyClient(asRole("app"));
useLinkedinClient(asRole("app"));

const content = (seeded: Seeded, step: string) =>
  run(seeded.workspaceId, () => approvedContent(step));
const press = (seeded: Seeded, id: string, as = seeded.asOwner, text?: string) =>
  run(seeded.workspaceId, () => approve(id, text === undefined ? {} : { text }, as));
const skipAs = (seeded: Seeded, id: string, as = seeded.asOwner) =>
  run(seeded.workspaceId, () => skip(id, as));

test("no approvedContent without the owner's approval: null for a pending, skipped or blocked item, for one decided by anyone but the account's owner, and for a step without one", async () => {
  const seeded = await seed();
  const { workspaceId, personId, accountId } = seeded;
  const [pending, skipped, blocked, approved] = [
    await readyItem(seeded),
    await readyItem(seeded),
    await readyItem(seeded),
    await readyItem(seeded),
  ];
  await assert.rejects(press(seeded, pending.approvalItemId, seeded.asOther), {
    code: "not_sender_owner",
  });
  await assert.rejects(skipAs(seeded, pending.approvalItemId, seeded.asOther), {
    code: "not_sender_owner",
  });
  await skipAs(seeded, skipped.approvalItemId);
  await run(workspaceId, () => cancelItems([blocked.stepExecutionId]));
  for (const { stepExecutionId } of [pending, skipped, blocked]) {
    assert.equal(await content(seeded, stepExecutionId), null, stepExecutionId);
  }
  assert.deepEqual([await content(seeded, "sx_none"), await content(seeded, "")], [null, null]);
  const decided = await press(seeded, approved.approvalItemId, seeded.asOwner, EDITED);
  assert.deepEqual(await content(seeded, approved.stepExecutionId), {
    text: EDITED,
    contentHash: sha256(EDITED),
    approvalItemId: approved.approvalItemId,
    approvedBy: seeded.ownerId,
    approvedAt: decided.decidedAt,
  });

  // Rows past the commands: an approval by another member, and one by the account's owner.
  const frozen = async (decidedBy: string) => {
    const stepExecutionId = stepId();
    const draft = { workspaceId, personId, stepExecutionId, status: "approved" as const };
    const draftId = await createStepDraft({ ...draft, text: TEXT });
    const hash = sha256(TEXT);
    const item = { workspaceId, personId, senderAccountId: accountId, stepExecutionId, draftId };
    await createApprovalItem({ ...item, status: "approved", approvedContentHash: hash, decidedBy });
    return stepExecutionId;
  };
  assert.equal(await content(seeded, await frozen(seeded.otherId)), null);
  assert.equal((await content(seeded, await frozen(seeded.ownerId)))?.text, TEXT);
});

test("changed content answers null: the frozen text or the approval's hash changed past the commands; a second approval, and messaging's own later edit, change nothing", async () => {
  const seeded = await seed();
  const item = await readyItem(seeded);
  await press(seeded, item.approvalItemId);
  assert.equal((await content(seeded, item.stepExecutionId))?.contentHash, sha256(TEXT));
  await assert.rejects(press(seeded, item.approvalItemId, seeded.asOwner, EDITED), {
    code: "approval_item_not_pending",
  });
  const { id } = await draftOf(seeded.workspaceId, item.stepExecutionId);
  const later = { text: EDITED, stepExecutionId: item.stepExecutionId };
  const refused = run(seeded.workspaceId, () => approveStepDraft(id, later));
  await assert.rejects(refused, { code: "draft_not_editable" });
  assert.equal((await content(seeded, item.stepExecutionId))?.text, TEXT);

  const app = asRole("app");
  await app.messageDraft.update({ where: { id }, data: { editedText: EDITED } });
  assert.equal(await content(seeded, item.stepExecutionId), null);
  await app.messageDraft.update({ where: { id }, data: { editedText: null } });
  assert.equal((await content(seeded, item.stepExecutionId))?.text, TEXT);
  const hash = { approvedContentHash: sha256(EDITED) };
  await app.approvalItem.update({ where: { id: item.approvalItemId }, data: hash });
  assert.equal(await content(seeded, item.stepExecutionId), null);
});

test("a blocked item is never approved or skipped: approval_item_not_pending, its draft unapproved, no decision", async () => {
  const seeded = await seed();
  const item = await readyItem(seeded);
  await run(seeded.workspaceId, () => cancelItems([item.stepExecutionId]));
  const notPending = { code: "approval_item_not_pending" };
  await assert.rejects(press(seeded, item.approvalItemId), notPending);
  await assert.rejects(skipAs(seeded, item.approvalItemId), notPending);
  const row = await itemOf(seeded.workspaceId, item.approvalItemId);
  assert.deepEqual([row.status, row.decidedBy, row.approvedContentHash], ["blocked", null, null]);
  assert.equal((await draftOf(seeded.workspaceId, item.stepExecutionId)).status, "ready");
  assert.equal(await content(seeded, item.stepExecutionId), null);
  assert.deepEqual(await decisions(seeded.workspaceId), []);
});

test("a decision applies once: of two approvals at once one wins, the other is approval_item_not_pending; a skip after an approval and an approval after a skip too; one approvals.item_decided each, ids and the decision only", async () => {
  const seeded = await seed();
  const approved = await readyItem(seeded);
  const both = await Promise.allSettled([
    press(seeded, approved.approvalItemId),
    press(seeded, approved.approvalItemId, seeded.asOwner, EDITED),
  ]);
  const lost = both.filter((result) => result.status === "rejected");
  assert.equal(lost.length, 1, "one press wins");
  assert.equal((lost[0]?.reason as { code?: string }).code, "approval_item_not_pending");
  const notPending = { code: "approval_item_not_pending" };
  await assert.rejects(skipAs(seeded, approved.approvalItemId), notPending);
  const skipped = await readyItem(seeded);
  await skipAs(seeded, skipped.approvalItemId);
  await assert.rejects(press(seeded, skipped.approvalItemId), notPending);
  await assert.rejects(skipAs(seeded, skipped.approvalItemId), notPending);
  assert.deepEqual(await decisions(seeded.workspaceId), [
    { ...approved, decision: "approved" },
    { ...skipped, decision: "skipped" },
  ]);
  const won = await content(seeded, approved.stepExecutionId);
  assert.ok(won?.text === TEXT || won?.text === EDITED, "the winner's text is the frozen one");
});
