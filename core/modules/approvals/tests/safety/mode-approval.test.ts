// The safety suite's cases of the mode's approval and of email items (gamma-p4-090; gamma's rules we
// keep: any AI message sent without per-message approval carries the AI disclosure line, and
// nothing goes out that its sender's owner did not approve; docs/security.md): an item the mode
// approved has a frozen text ending with its channel's line, which its hash covers; approvedContent
// answers the mode's approval only to a caller that asks with allowMode; the mode approves nothing
// but an item opened for it with a `ready` draft that passes messaging's checks; an email item is
// decided by its mailbox's owner alone, and its frozen subject and body answer only while unchanged.
import assert from "node:assert/strict";
import { test } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { createStepDraft } from "@whytide/messaging/testing";
import { useTenancyClient } from "@whytide/tenancy/testing";
import { approve, skip } from "../../domain/items/decide.ts";
import { approvedContent } from "../../domain/items/queries.ts";
import { createApprovalItem } from "../../testing/index.ts";
import {
  createMailbox,
  decisions,
  draftOf,
  EDITED,
  EDITED_SUBJECT,
  emailHash,
  endDraft,
  itemOf,
  LINE,
  open,
  openEmail,
  readyEmail,
  readyItem,
  run,
  type Seeded,
  SUBJECT,
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
const withMode = (seeded: Seeded, step: string, allowMode = true) =>
  run(seeded.workspaceId, () => approvedContent(step, { allowMode }));
const press = (seeded: Seeded, id: string, as = seeded.asOwner, input: object = {}) =>
  run(seeded.workspaceId, () => approve(id, input, as));
const skipAs = (seeded: Seeded, id: string, as = seeded.asOwner) =>
  run(seeded.workspaceId, () => skip(id, as));
/** A text, a blank line and the channel's AI disclosure line, as the mode freezes it. */
const lined = (channel: keyof typeof LINE) => `${TEXT}\n\n${LINE[channel]}`;
/** The most characters a LinkedIn message may have (messaging's gates). */
const MESSAGE_LIMIT = 1_900;
/** A text of exactly `length` characters that passes messaging's gates, as its tests make one. */
const sized = (length: number) =>
  `${"Ines, how does your team follow up on warm leads".padEnd(length - 1, " so")}?`;

test("the line: an item opened for the mode is approved by it once its draft is ready, a LinkedIn message and a first email alike: approved, origin approval_mode, no decided_by, the frozen text ending with its channel's line and the item's hash covering it, an email's subject too; one approvals.item_decided each", async () => {
  const seeded = await seed();
  const { workspaceId } = seeded;
  assert.notEqual(LINE.linkedin, "");
  assert.notEqual(LINE.email, "");
  const linkedin = await readyItem(seeded, { approvalBy: "mode" });
  const email = await readyEmail(seeded, { approvalBy: "mode" });
  const expected = [
    { opened: linkedin, text: lined("linkedin"), hash: sha256(lined("linkedin")) },
    { opened: email, text: lined("email"), hash: emailHash(lined("email"), SUBJECT) },
  ];
  for (const { opened, text, hash } of expected) {
    const item = await itemOf(workspaceId, opened.approvalItemId);
    assert.deepEqual(
      [item.status, item.approvalBy, item.decisionOrigin, item.decidedBy, item.waitCode],
      ["approved", "mode", "approval_mode", null, null],
    );
    assert.equal(item.approvedContentHash, hash);
    assert.ok(item.decidedAt instanceof Date);
    const answer = await withMode(seeded, opened.stepExecutionId);
    assert.equal(answer?.text, text);
    assert.equal(answer?.contentHash, hash);
    assert.deepEqual(
      [answer?.origin, answer?.approvedBy, answer?.disclosureApplied, answer?.approvedAt],
      ["approval_mode", null, true, item.decidedAt],
    );
    const draft = await draftOf(workspaceId, opened.stepExecutionId);
    assert.deepEqual([draft.status, draft.editedText], ["approved", text]);
  }
  assert.equal((await withMode(seeded, email.stepExecutionId))?.subject, SUBJECT);
  assert.equal((await withMode(seeded, linkedin.stepExecutionId))?.subject, undefined);
  assert.deepEqual(await decisions(workspaceId), [
    { ...linkedin, decision: "approved" },
    {
      approvalItemId: email.approvalItemId,
      stepExecutionId: email.stepExecutionId,
      decision: "approved",
    },
  ]);
});

test("the default refusal: without allowMode, or with it false, approvedContent answers null for the mode's approval, so a send that asks a person's approval never carries it; a person's approval answers either way, origin app, no line; a mode's approval of a text without its line answers null even with allowMode", async () => {
  const seeded = await seed();
  const { workspaceId, personId, accountId } = seeded;
  const mode = await readyItem(seeded, { approvalBy: "mode" });
  assert.equal((await itemOf(workspaceId, mode.approvalItemId)).status, "approved");
  assert.equal(await content(seeded, mode.stepExecutionId), null);
  assert.equal(await withMode(seeded, mode.stepExecutionId, false), null);
  assert.equal((await withMode(seeded, mode.stepExecutionId))?.text, lined("linkedin"));

  const person = await readyItem(seeded);
  const decided = await press(seeded, person.approvalItemId);
  const plain = {
    text: TEXT,
    contentHash: sha256(TEXT),
    approvalItemId: person.approvalItemId,
    approvedBy: seeded.ownerId,
    approvedAt: decided.decidedAt,
  };
  assert.deepEqual(await content(seeded, person.stepExecutionId), plain);
  const told = { ...plain, origin: "app", disclosureApplied: false };
  assert.deepEqual(await withMode(seeded, person.stepExecutionId), told);
  assert.deepEqual(await withMode(seeded, person.stepExecutionId, false), told);

  // Rows past the commands: the mode's origin on a person's frozen text, which has no line.
  const stepExecutionId = stepId();
  const draft = { workspaceId, personId, stepExecutionId, status: "approved" as const };
  const draftId = await createStepDraft({ ...draft, text: TEXT });
  const item = { workspaceId, personId, senderAccountId: accountId, stepExecutionId, draftId };
  const hash = { approvedContentHash: sha256(TEXT) };
  await createApprovalItem({
    ...item,
    status: "approved",
    ...hash,
    decisionOrigin: "approval_mode",
  });
  assert.equal(await withMode(seeded, stepExecutionId), null);
  assert.equal(await content(seeded, stepExecutionId), null);
});

test("the mode approves nothing else: an item opened for a person stays pending with its ready draft and no wait; an item opened for the mode stays pending with mode_declined for a connection request, a flagged, failed or edited draft, and a text messaging's checks refuse with its line; no draft of theirs is approved and no decision is published", async () => {
  const seeded = await seed();
  const { workspaceId } = seeded;
  const mode = { approvalBy: "mode" as const };
  const person = await readyItem(seeded);
  const invite = await open(seeded, { stepKey: "connect", ...mode });
  const ended = async (status: "flagged" | "failed" | "edited", text?: string | null) => {
    const opened = await open(seeded, mode);
    await endDraft(workspaceId, opened.stepExecutionId, status, text);
    return opened;
  };
  const flagged = await ended("flagged");
  const failed = await ended("failed");
  const edited = await ended("edited", EDITED);
  // At the length a message may have, over it once its line is added: messaging refuses it.
  const long = await open(seeded, mode);
  const text = sized(MESSAGE_LIMIT - LINE.linkedin.length);
  await endDraft(workspaceId, long.stepExecutionId, "ready", text);

  const personRow = await itemOf(workspaceId, person.approvalItemId);
  assert.deepEqual(
    [personRow.status, personRow.approvalBy, personRow.waitCode],
    ["pending", "person", null],
  );
  assert.equal((await draftOf(workspaceId, person.stepExecutionId)).status, "ready");
  const declined = [
    [invite, "ready"],
    [flagged, "flagged"],
    [failed, "failed"],
    [edited, "edited"],
    [long, "ready"],
  ] as const;
  for (const [opened, status] of declined) {
    const row = await itemOf(workspaceId, opened.approvalItemId);
    assert.deepEqual(
      [row.status, row.waitCode, row.waitUntil, row.decidedBy, row.decisionOrigin],
      ["pending", "mode_declined", null, null, null],
      opened.stepExecutionId,
    );
    assert.notEqual(row.draftId, null);
    assert.equal((await draftOf(workspaceId, opened.stepExecutionId)).status, status);
    assert.equal(await withMode(seeded, opened.stepExecutionId), null);
  }
  assert.deepEqual(await decisions(workspaceId), []);
});

test("the mailbox's owner: an email item is approved or skipped by its mailbox's owner alone, not_sender_owner for the LinkedIn account's owner and anyone else; the approved subject and body are frozen, and changed behind approvals' back answer null; an email item decided by anyone but the mailbox's owner answers null", async () => {
  const seeded = await seed();
  const { workspaceId, personId, otherId, asOther } = seeded;
  const notOwner = { code: "not_sender_owner" };
  const mailboxId = await createMailbox(workspaceId, otherId);
  const theirs = await openEmail(seeded, { mailboxId, senderUserId: otherId });
  await endDraft(workspaceId, theirs.stepExecutionId, "ready", TEXT, SUBJECT);
  await assert.rejects(press(seeded, theirs.approvalItemId), notOwner);
  await assert.rejects(skipAs(seeded, theirs.approvalItemId), notOwner);
  const pending = await itemOf(workspaceId, theirs.approvalItemId);
  assert.deepEqual(
    [pending.status, pending.mailboxId, pending.senderAccountId],
    ["pending", mailboxId, null],
  );

  const input = { subject: EDITED_SUBJECT, draftId: pending.draftId };
  const decided = await press(seeded, theirs.approvalItemId, asOther, input);
  const hash = emailHash(TEXT, EDITED_SUBJECT);
  assert.deepEqual(await content(seeded, theirs.stepExecutionId), {
    text: TEXT,
    subject: EDITED_SUBJECT,
    contentHash: hash,
    approvalItemId: theirs.approvalItemId,
    approvedBy: otherId,
    approvedAt: decided.decidedAt,
  });
  const app = asRole("app");
  const { id } = await draftOf(workspaceId, theirs.stepExecutionId);
  await app.messageDraft.update({ where: { id }, data: { editedSubject: SUBJECT } });
  assert.equal(await content(seeded, theirs.stepExecutionId), null);
  await app.messageDraft.update({ where: { id }, data: { editedSubject: EDITED_SUBJECT } });
  assert.equal((await content(seeded, theirs.stepExecutionId))?.contentHash, hash);
  await app.messageDraft.update({ where: { id }, data: { editedText: EDITED } });
  assert.equal(await content(seeded, theirs.stepExecutionId), null);

  const owned = await readyEmail(seeded);
  await assert.rejects(skipAs(seeded, owned.approvalItemId, asOther), notOwner);
  assert.equal((await skipAs(seeded, owned.approvalItemId)).status, "skipped");

  // Rows past the commands: an email approved by the account's owner, and by the mailbox's.
  const frozen = async (decidedBy: string) => {
    const stepExecutionId = stepId();
    const step = { workspaceId, personId, stepExecutionId, stepKey: "email_1" as const, mailboxId };
    const columns = { status: "approved" as const, text: TEXT, subject: SUBJECT };
    const draftId = await createStepDraft({ ...step, ...columns });
    const item = { workspaceId, personId, mailboxId, stepExecutionId, draftId };
    const approvedContentHash = emailHash(TEXT, SUBJECT);
    await createApprovalItem({ ...item, status: "approved", approvedContentHash, decidedBy });
    return stepExecutionId;
  };
  assert.equal(await content(seeded, await frozen(seeded.ownerId)), null);
  assert.equal((await content(seeded, await frozen(otherId)))?.subject, SUBJECT);
});
