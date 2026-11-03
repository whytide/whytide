// The items' commands and queries (README.md "Public interface"), each in a tenant run as campaigns
// and the routes call them, against the worktree's database: an open and its draft, the attach,
// the approval's texts, the cancel and the wait, the latest decisions, the edit report, and the
// days and the queue in the sender's zone. The owner checks and the frozen content are the safety
// suite's (tests/safety/); the routes' refusals the api's (core/apps/api/tests/approvals-items.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { createConnectedAccount, useLinkedinClient } from "@whytide/linkedin/testing";
import { useTenancyClient } from "@whytide/tenancy/testing";
import { cancelItems } from "../domain/items/cancel.ts";
import { approve, skip } from "../domain/items/decide.ts";
import { type OpenItemInput, openItem } from "../domain/items/open.ts";
import { decisionDays, decisionsFor, editStats } from "../domain/items/queries.ts";
import { readQueue } from "../domain/items/queue.ts";
import { noteItemWait } from "../domain/items/wait.ts";
import { createApprovalItem } from "../testing/index.ts";
import {
  deliverDraftEnd,
  draftOf,
  EDITED,
  EMPTY_HASH,
  endDraft,
  itemOf,
  NOTE,
  open,
  readyItem,
  run,
  type Seeded,
  seed,
  sha256,
  stepId,
  TEXT,
} from "./fixtures/items.ts";

withTestDb();
useTenancyClient(asRole("app"));
useLinkedinClient(asRole("app"));

const invalid = (...fields: string[]) => ({ code: "approvals_input_invalid", details: { fields } });
const approveAs = (seeded: Seeded, id: string, text?: string) =>
  run(seeded.workspaceId, () => approve(id, text === undefined ? {} : { text }, seeded.asOwner));
const skipAs = (seeded: Seeded, id: string) =>
  run(seeded.workspaceId, () => skip(id, seeded.asOwner));

test("openItem: one pending item and one draft per step, whatever opens it again; a note attached at once; a withdrawal refused", async () => {
  const seeded = await seed();
  const { workspaceId, personId, accountId: senderAccountId, ownerId: senderUserId } = seeded;
  const scheduledFor = new Date("2026-10-30T09:00:00.000Z");
  const step = { stepExecutionId: stepId(), personId, senderAccountId, senderUserId, scheduledFor };
  const message = { ...step, actionType: "message", stepKey: "message_1" } as const;
  const { approvalItemId } = await run(workspaceId, () => openItem(message));
  const again = { ...message, stepKey: "follow_up_1", earlierDraftIds: ["mdr_x"] };
  assert.deepEqual(await run(workspaceId, () => openItem(again)), { approvalItemId });
  const item = await itemOf(workspaceId, approvalItemId);
  const { status, draftId, actionType, stepKey } = item;
  assert.deepEqual(
    [status, draftId, actionType, stepKey],
    ["pending", null, "message", "message_1"],
  );
  assert.equal(item.scheduledFor.toISOString(), scheduledFor.toISOString());
  const drafts = await run(workspaceId, (tx) => tx.messageDraft.findMany());
  assert.deepEqual(
    drafts.map((draft) => [draft.stepExecutionId, draft.status]),
    [[step.stepExecutionId, "drafting"]],
  );

  const connect = await open(seeded, { stepKey: "connect" });
  const note = await itemOf(workspaceId, connect.approvalItemId);
  const noteDraft = await draftOf(workspaceId, connect.stepExecutionId);
  assert.deepEqual(
    [note.actionType, note.draftId, noteDraft.status],
    ["invite", noteDraft.id, "ready"],
  );

  const other = { ...message, stepExecutionId: stepId() };
  const opening = (input: OpenItemInput) => run(workspaceId, () => openItem(input));
  await assert.rejects(opening({ ...other, stepKey: "withdraw" }), invalid("stepKey"));
  const withdraw = { ...other, actionType: "withdraw" as "message" };
  await assert.rejects(opening(withdraw), invalid("actionType"));
  await assert.rejects(opening({ ...other, stepKey: "message_9" }), {
    code: "messaging_input_invalid",
  });
  assert.equal(await run(workspaceId, (tx) => tx.approvalItem.count()), 2);
});

test("the attach: messaging.step_draft_ready gives the step's pending item its draft once; a redelivery, a blocked item and an unknown step change nothing; a step opened again after a block gets its draft at once", async () => {
  const seeded = await seed();
  const { workspaceId } = seeded;
  const { approvalItemId, stepExecutionId } = await open(seeded);
  const draftId = await endDraft(workspaceId, stepExecutionId);
  const attached = await itemOf(workspaceId, approvalItemId);
  assert.equal(attached.draftId, draftId);
  await deliverDraftEnd(workspaceId, { draftId: "mdr_other", stepExecutionId, status: "ready" });
  await deliverDraftEnd(workspaceId, { draftId, stepExecutionId: "sx_unknown", status: "ready" });
  assert.deepEqual(await itemOf(workspaceId, approvalItemId), attached);

  const blocked = await open(seeded);
  assert.equal(await run(workspaceId, () => cancelItems([blocked.stepExecutionId])), 1);
  const blockedDraft = await endDraft(workspaceId, blocked.stepExecutionId);
  const row = await itemOf(workspaceId, blocked.approvalItemId);
  assert.deepEqual([row.status, row.draftId], ["blocked", null]);
  const reopened = await open(seeded, { stepExecutionId: blocked.stepExecutionId });
  const fresh = await itemOf(workspaceId, reopened.approvalItemId);
  assert.deepEqual(
    [fresh.id === row.id, fresh.status, fresh.draftId],
    [false, "pending", blockedDraft],
  );
});

test("approve's texts: the draft's own or the owner's, trimmed, hashed as frozen; an empty or typed note; a failed draft only with a typed text; a text over 4,000 refused", async () => {
  const seeded = await seed();
  const own = await readyItem(seeded);
  const approved = await approveAs(seeded, own.approvalItemId);
  const { status, approvedContentHash, decidedBy } = approved;
  assert.deepEqual(
    [status, approvedContentHash, decidedBy],
    ["approved", sha256(TEXT), seeded.ownerId],
  );
  const edited = await readyItem(seeded);
  const frozen = await approveAs(seeded, edited.approvalItemId, `  ${EDITED}\n`);
  assert.equal(frozen.approvedContentHash, sha256(EDITED));
  const draft = await draftOf(seeded.workspaceId, edited.stepExecutionId);
  assert.deepEqual([draft.status, draft.editedText], ["approved", EDITED]);
  for (const [note, hash] of [
    ["", EMPTY_HASH],
    [NOTE, sha256(NOTE)],
  ]) {
    const invite = await readyItem(seeded, { stepKey: "connect" });
    assert.equal((await approveAs(seeded, invite.approvalItemId, note)).approvedContentHash, hash);
  }

  const failed = await open(seeded);
  await endDraft(seeded.workspaceId, failed.stepExecutionId, "failed");
  const empty = { gate: "length", length: 0, min: 1, max: 1_900 };
  await assert.rejects(approveAs(seeded, failed.approvalItemId), {
    code: "draft_text_refused",
    details: { issues: [empty] },
  });
  assert.equal((await approveAs(seeded, failed.approvalItemId, TEXT)).status, "approved");
  await assert.rejects(
    approveAs(seeded, failed.approvalItemId, "x".repeat(4_001)),
    invalid("text"),
  );
});

test("skip leaves the draft as it is; cancelItems blocks the steps' pending items only; noteItemWait sets and clears an approved step's wait", async () => {
  const seeded = await seed();
  const { workspaceId } = seeded;
  const [pending, approved, skipped] = [
    await readyItem(seeded),
    await readyItem(seeded),
    await readyItem(seeded),
  ];
  const items = [pending, approved, skipped];
  await approveAs(seeded, approved.approvalItemId);
  const row = await skipAs(seeded, skipped.approvalItemId);
  assert.deepEqual([row.status, row.decidedBy], ["skipped", seeded.ownerId]);
  assert.equal((await draftOf(workspaceId, skipped.stepExecutionId)).status, "ready");

  const cancel = (ids: string[]) => run(workspaceId, () => cancelItems(ids));
  const steps = items.map(({ stepExecutionId }) => stepExecutionId);
  assert.equal(await cancel([...steps, "sx_none", pending.stepExecutionId]), 1);
  assert.deepEqual([await cancel([]), await cancel(["sx_none"])], [0, 0]);
  await assert.rejects(cancel([""]), invalid("0"));
  const statuses = items.map(
    async ({ approvalItemId }) => (await itemOf(workspaceId, approvalItemId)).status,
  );
  assert.deepEqual(await Promise.all(statuses), ["blocked", "approved", "skipped"]);

  const wait = (step: string, value: Parameters<typeof noteItemWait>[1]) =>
    run(workspaceId, () => noteItemWait(step, value));
  const waitOf = async () => {
    const { waitCode, waitUntil } = await itemOf(workspaceId, approved.approvalItemId);
    return [waitCode, waitUntil?.toISOString() ?? null];
  };
  const until = "2026-10-30T09:00:00.000Z";
  assert.equal(await wait(approved.stepExecutionId, { code: "insufficient_credits", until }), 1);
  assert.deepEqual(await waitOf(), ["insufficient_credits", until]);
  assert.equal(await wait(approved.stepExecutionId, { code: "note_budget" }), 1);
  assert.deepEqual(await waitOf(), ["note_budget", null]);
  assert.equal(await wait(approved.stepExecutionId, null), 1);
  assert.deepEqual(await waitOf(), [null, null]);
  assert.equal(await wait(pending.stepExecutionId, { code: "note_budget" }), 0);
  await assert.rejects(wait(approved.stepExecutionId, { code: "Not A Code" }), invalid("code"));
});

test("decisionsFor: each step's latest item, in the order asked, once; a step without one is left out", async () => {
  const seeded = await seed();
  const { workspaceId } = seeded;
  const first = await readyItem(seeded);
  await run(workspaceId, () => cancelItems([first.stepExecutionId]));
  const reopened = await open(seeded, { stepExecutionId: first.stepExecutionId });
  const second = await readyItem(seeded);
  await approveAs(seeded, second.approvalItemId);
  const asked = [second.stepExecutionId, first.stepExecutionId, "sx_none", second.stepExecutionId];
  const found = await run(workspaceId, () => decisionsFor(asked));
  assert.deepEqual(
    found.map(({ stepExecutionId, approvalItemId, status, decidedBy }) => {
      return { stepExecutionId, approvalItemId, status, decidedBy };
    }),
    [
      { ...second, status: "approved", decidedBy: seeded.ownerId },
      { ...reopened, status: "pending", decidedBy: null },
    ],
  );
  assert.deepEqual(await run(workspaceId, () => decisionsFor([])), []);
});

test("editStats: the approvals since, those unedited and those with a small edit; an invite with an empty note is left out; 0.2 is small, 0.21 is not", async () => {
  const seeded = await seed();
  const since = new Date();
  const changed = (n: number) => `Ines, ${"b".repeat(n)}${"a".repeat(94 - n)}`;
  for (const text of [undefined, changed(20), changed(21)]) {
    const { approvalItemId, stepExecutionId } = await open(seeded);
    await endDraft(seeded.workspaceId, stepExecutionId, "ready", changed(0));
    await approveAs(seeded, approvalItemId, text);
  }
  for (const note of ["", NOTE]) {
    await approveAs(seeded, (await readyItem(seeded, { stepKey: "connect" })).approvalItemId, note);
  }
  await skipAs(seeded, (await readyItem(seeded)).approvalItemId);
  const stats = (from: Date | string) => run(seeded.workspaceId, () => editStats({ since: from }));
  assert.deepEqual(await stats(since), { approved: 4, unedited: 1, smallEdits: 1 });
  const later = new Date(Date.now() + 60_000);
  assert.deepEqual(await stats(later), { approved: 0, unedited: 0, smallEdits: 0 });
  await assert.rejects(stats("yesterday"), invalid("since"));
});

test("decisionDays and the queue in each sender's zone, a gone account's in UTC: the days with decisions; the pending items and the approved ones that wait, by due time, stale, needing attention, decided by their owner; toApprove and decidedToday", async () => {
  const seeded = await seed();
  const { workspaceId, personId, accountId: utc } = seeded;
  // The other member's own account: one account per member and workspace.
  const ownerUserId = seeded.otherId;
  const auckland = (
    await createConnectedAccount(workspaceId, { ownerUserId, timeZone: "Pacific/Auckland" })
  ).id;
  const now = new Date("2026-10-22T10:00:00.000Z"); // 23:00 in Auckland (UTC+13)
  const at = (iso: string) => new Date(`2026-10-${iso}:00.000Z`);
  type Columns = Partial<Parameters<typeof createApprovalItem>[0]>;
  const item = (senderAccountId: string, columns: Columns) =>
    createApprovalItem({
      workspaceId,
      personId,
      senderAccountId,
      stepExecutionId: stepId(),
      ...columns,
    });
  // In Auckland, today began at 11:00 UTC the day before; in UTC, at midnight.
  await item(auckland, { status: "approved", decidedAt: at("21T11:30") });
  await item(auckland, { status: "skipped", decidedAt: at("21T10:30") });
  await item(utc, { status: "approved", decidedAt: at("22T09:00") });
  await item(utc, { status: "skipped", decidedAt: at("21T23:00") });
  await item("lac_gone", { status: "skipped", decidedAt: at("21T23:30") });
  const days = await run(workspaceId, () => decisionDays({ since: at("21T00:00") }));
  const day = (senderAccountId: string, date: string) => ({
    senderAccountId,
    day: `2026-10-${date}`,
    decisions: 1,
  });
  const expected = [
    day(auckland, "21"),
    day(auckland, "22"),
    day(utc, "21"),
    day(utc, "22"),
    day("lac_gone", "21"),
  ];
  const order = (a: { senderAccountId: string }, b: { senderAccountId: string }) =>
    a.senderAccountId < b.senderAccountId ? -1 : a.senderAccountId > b.senderAccountId ? 1 : 0;
  assert.deepEqual(days, expected.sort(order));

  const old = at("19T10:00"); // three days before now, to the millisecond
  const ids = [
    await item(auckland, { scheduledFor: at("21T10:30"), createdAt: old }),
    await item(auckland, { scheduledFor: at("21T11:30"), createdAt: new Date(old.getTime() + 1) }),
    await item(utc, {
      status: "approved",
      scheduledFor: at("22T08:00"),
      waitCode: "insufficient_credits",
      ...{ createdAt: old, decidedAt: old },
    }),
  ];
  await item(utc, { status: "approved", scheduledFor: at("20T08:00"), decidedAt: old });
  await item(utc, { status: "blocked", scheduledFor: at("20T08:00") });
  const queue = await run(workspaceId, () => readQueue(seeded.asOwner, now));
  const flags = queue.items.map(({ id, stale, needsAttention, canDecide }) => [
    id,
    stale,
    needsAttention,
    canDecide,
  ]);
  assert.deepEqual(flags, [
    [ids[0], true, true, false],
    [ids[1], false, false, false],
    [ids[2], false, false, true],
  ]);
  const [first] = queue.items;
  assert.deepEqual(first?.sender, {
    accountId: auckland,
    label: "LinkedIn",
    timeZone: "Pacific/Auckland",
  });
  assert.deepEqual(
    [first?.lead?.firstName, first?.lead?.companyName, first?.draft],
    ["Ines", "Acme", null],
  );
  assert.deepEqual(queue.counts, { toApprove: 2, decidedToday: 2 });
  const theirs = await run(workspaceId, () => readQueue(seeded.asOther, now));
  assert.deepEqual(
    theirs.items.map(({ canDecide }) => canDecide),
    [true, true, false],
  );
});
