// An email step's item (gamma-p4-090), each command and query in a tenant run as campaigns and the
// routes call them, against the worktree's database: the open with its mailbox, the approval with
// the subject and the shown draft, the skip, the queue with its sender and the days in the
// mailbox's zone. The mailbox owner's decision and the frozen content are the safety suite's
// (tests/safety/mode-approval.test.ts); the routes' answers the api's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { useTenancyClient } from "@whytide/tenancy/testing";
import { approve, skip } from "../domain/items/decide.ts";
import { type OpenItemInput, openItem } from "../domain/items/open.ts";
import { decisionDays } from "../domain/items/queries.ts";
import { readQueue } from "../domain/items/queue.ts";
import {
  createMailbox,
  decisions,
  draftOf,
  EDITED,
  EDITED_SUBJECT,
  emailHash,
  endDraft,
  itemOf,
  openEmail,
  readyEmail,
  readyItem,
  run,
  type Seeded,
  SUBJECT,
  seed,
  stepId,
  TEXT,
} from "./fixtures/items.ts";

withTestDb();
useTenancyClient(asRole("app"));
useLinkedinClient(asRole("app"));

const invalid = (...fields: string[]) => ({ code: "approvals_input_invalid", details: { fields } });
const approveAs = (seeded: Seeded, id: string, input: object, as = seeded.asOwner) =>
  run(seeded.workspaceId, () => approve(id, input, as));

test("openItem for an email: an `email` item with its mailbox and no account, its draft asked of messaging for the mailbox; a second open answers it; an email without its mailbox or with an account, and any other step with a mailbox, approvals_input_invalid", async () => {
  const seeded = await seed();
  const { workspaceId, personId, accountId, ownerId } = seeded;
  const opened = await openEmail(seeded);
  const item = await itemOf(workspaceId, opened.approvalItemId);
  assert.deepEqual(
    [item.actionType, item.stepKey, item.mailboxId, item.senderAccountId, item.draftId],
    ["email", "email_1", opened.mailboxId, null, null],
  );
  assert.deepEqual([item.status, item.approvalBy], ["pending", "person"]);
  const draft = await run(workspaceId, (tx) =>
    tx.messageDraft.findFirstOrThrow({ where: { stepExecutionId: opened.stepExecutionId } }),
  );
  assert.deepEqual(
    [draft.channel, draft.mailboxId, draft.status],
    ["email", opened.mailboxId, "drafting"],
  );
  const again = await openEmail(seeded, {
    stepExecutionId: opened.stepExecutionId,
    mailboxId: opened.mailboxId,
  });
  assert.equal(again.approvalItemId, opened.approvalItemId);

  const step = { stepExecutionId: stepId(), personId, senderUserId: ownerId };
  const email = { ...step, actionType: "email", stepKey: "email_2", scheduledFor: new Date() };
  const opening = (input: OpenItemInput) => run(workspaceId, () => openItem(input));
  const mailboxId = opened.mailboxId;
  await assert.rejects(opening(email as OpenItemInput), invalid("mailboxId"));
  await assert.rejects(
    opening({ ...email, mailboxId, senderAccountId: accountId } as OpenItemInput),
    invalid("senderAccountId"),
  );
  const message = { ...email, actionType: "message", stepKey: "message_1", mailboxId };
  await assert.rejects(
    opening({ ...message, senderAccountId: accountId } as OpenItemInput),
    invalid("mailboxId"),
  );
  await assert.rejects(opening(message as OpenItemInput), invalid("mailboxId", "senderAccountId"));
  assert.equal(await run(workspaceId, (tx) => tx.approvalItem.count()), 1);
});

test("approve an email: the draft's own subject and body, or the owner's, frozen and hashed together; the shown draftId approves, another answers approval_draft_changed and approves nothing; a subject on a LinkedIn item approval_subject_not_allowed, on a follow-up messaging's draft_subject_not_allowed; skip an email", async () => {
  const seeded = await seed();
  const { workspaceId } = seeded;
  const own = await readyEmail(seeded);
  const ownDraft = await draftOf(workspaceId, own.stepExecutionId);
  const approved = await approveAs(seeded, own.approvalItemId, { draftId: ownDraft.id });
  assert.deepEqual(
    [approved.status, approved.approvedContentHash, approved.decisionOrigin],
    ["approved", emailHash(TEXT, SUBJECT), "app"],
  );

  const edited = await readyEmail(seeded);
  const stale = { subject: EDITED_SUBJECT, text: EDITED, draftId: ownDraft.id };
  await assert.rejects(approveAs(seeded, edited.approvalItemId, stale), {
    code: "approval_draft_changed",
  });
  const unchanged = await itemOf(workspaceId, edited.approvalItemId);
  assert.deepEqual([unchanged.status, unchanged.approvedContentHash], ["pending", null]);
  assert.equal((await draftOf(workspaceId, edited.stepExecutionId)).status, "ready");
  const shown = { ...stale, draftId: unchanged.draftId };
  const frozen = await approveAs(seeded, edited.approvalItemId, shown);
  assert.equal(frozen.approvedContentHash, emailHash(EDITED, EDITED_SUBJECT));

  const linkedin = await readyItem(seeded);
  await assert.rejects(approveAs(seeded, linkedin.approvalItemId, { subject: SUBJECT }), {
    code: "approval_subject_not_allowed",
  });
  const followUp = await openEmail(seeded, { stepKey: "email_2" });
  await endDraft(workspaceId, followUp.stepExecutionId);
  await assert.rejects(approveAs(seeded, followUp.approvalItemId, { subject: SUBJECT }), {
    code: "draft_subject_not_allowed",
  });
  const followed = await approveAs(seeded, followUp.approvalItemId, {});
  assert.equal(followed.approvedContentHash, emailHash(TEXT, null));

  const skipped = await readyEmail(seeded);
  const row = await run(workspaceId, () => skip(skipped.approvalItemId, seeded.asOwner));
  assert.deepEqual(
    [row.status, row.decidedBy, row.mailboxId],
    ["skipped", seeded.ownerId, skipped.mailboxId],
  );
  const decided = (opened: { approvalItemId: string; stepExecutionId: string }) => ({
    approvalItemId: opened.approvalItemId,
    stepExecutionId: opened.stepExecutionId,
  });
  assert.deepEqual(await decisions(workspaceId), [
    { ...decided(own), decision: "approved" },
    { ...decided(edited), decision: "approved" },
    { ...decided(followUp), decision: "approved" },
    { ...decided(skipped), decision: "skipped" },
  ]);
});

test("the queue and the days: an email item is in its mailbox's owner's queue only, under its mailbox (gamma-p6-050), with its channel, its mailbox as its sender, by its address in its zone with no account, the draft's subject and its limits; its decisions count on the mailbox's local day", async () => {
  const seeded = await seed();
  const { workspaceId, otherId } = seeded;
  const mailboxId = await createMailbox(workspaceId, otherId, "Asia/Kolkata");
  const theirs = await openEmail(seeded, { mailboxId, senderUserId: otherId });
  await endDraft(workspaceId, theirs.stepExecutionId, "ready", TEXT, SUBJECT);
  const queue = await run(workspaceId, () => readQueue(seeded.asOther));
  const [item] = queue.items;
  assert.deepEqual(
    [item?.channel, item?.mailboxId, item?.approvalBy, item?.canDecide],
    ["email", mailboxId, "person", true],
  );
  const mailbox = await run(workspaceId, (tx) =>
    tx.mailbox.findFirstOrThrow({ where: { id: mailboxId } }),
  );
  assert.deepEqual(item?.sender, {
    accountId: null,
    label: mailbox.emailAddress,
    timeZone: "Asia/Kolkata",
  });
  assert.deepEqual(
    [item?.draft?.subject, item?.draft?.maxSubjectWords, item?.draft?.maxSubjectCharacters],
    [SUBJECT, 6, 60],
  );
  const label = mailbox.emailAddress;
  assert.deepEqual(queue.senders, [
    { accountId: null, mailboxId, label, timeZone: "Asia/Kolkata", toApprove: 1, decidedToday: 0 },
  ]);
  // The LinkedIn account's owner owns no mailbox: their queue has their account, and no item.
  const ownerQueue = await run(workspaceId, () => readQueue(seeded.asOwner));
  assert.deepEqual(ownerQueue.items, []);
  assert.deepEqual(
    ownerQueue.senders.map(({ accountId, mailboxId }) => [accountId, mailboxId]),
    [[seeded.accountId, null]],
  );

  // 20:00 UTC is the next day in Kolkata (UTC+5:30).
  await approveAs(seeded, theirs.approvalItemId, {}, seeded.asOther);
  const decidedAt = new Date("2026-11-10T20:00:00.000Z");
  await asRole("app").approvalItem.update({
    where: { id: theirs.approvalItemId },
    data: { decidedAt },
  });
  const since = new Date("2026-11-01T00:00:00.000Z");
  assert.deepEqual(await run(workspaceId, () => decisionDays({ since })), [
    { senderAccountId: mailboxId, day: "2026-11-11", decisions: 1 },
  ]);
});
