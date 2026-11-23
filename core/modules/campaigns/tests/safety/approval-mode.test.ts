// The approval mode's safety cases (gamma-p4-070; README.md "The approval mode"; docs/security.md),
// run by `pnpm -F campaigns test:safety` and not by `test`, on the worktree's database in this file's
// schema, through a harness that reserves only on the gate's pass: in review_first_touches a
// follow-up's item opens for the mode, and the mode's approval, its text frozen with the AI
// disclosure line, passes with the hash of the text and the line; a connection request and a first
// message wait for a person, and the mode's approval of either is refused; in review_everything, and
// during a campaign's first 7 days whatever its mode says, every item opens for a person and the
// mode's approval is refused not_approved; review_first_touches is refused during the lock, taken at
// its end; the switch back returns every step of the mode's to `planned`, its item blocked and its
// draft ready again without the line, so a person approves it before any send, and the gate refuses
// the mode's approval of a step the switch back did not reach. review-gaps: a follow-up is a first
// touch until a message of its enrollment went out: after a first message skipped or failed, its
// item opens for a person, the gate refuses the mode's approval of it, and a person's approval
// passes it as a first touch; an enrollment or a step the read does not find is a first touch too.
// Each refusal skips the step and reserves nothing. LinkedIn's steps only: the email's are
// gamma-p4-010's.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { afterEach, beforeEach } from "node:test";
import { attachStepDraft } from "@whytide/approvals/testing";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import { reserveSend } from "@whytide/linkedin";
import { openSending, useClock, useLinkedinClient, useRandom } from "@whytide/linkedin/testing";
import { servicePrincipal } from "@whytide/platform";
import { useClient } from "../../domain/approval-mode/client.ts";
import { REVIEW_EVERYTHING_DAYS } from "../../domain/approval-mode/constants.ts";
import { stepRequirement } from "../../domain/approval-mode/requirement.ts";
import { changeApprovalMode } from "../../domain/approval-mode/set.ts";
import { createCampaign } from "../../domain/campaigns/commands.ts";
import { useClock as useCampaignsClock } from "../../domain/clock.ts";
import { MS_PER_DAY } from "../../domain/constants.ts";
import { checkGate } from "../../domain/gate/gate.ts";
import { linkedinActionType } from "../../domain/steps/actions.ts";
import { TEMPLATE_ID } from "../../domain/template/constants.ts";
import { APPROVER, fixture } from "../fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
useClient(asRole("app"));
// linkedin's reservation reads its own clock: a Wednesday morning, inside the account's hours.
useClock(() => new Date("2026-10-28T10:00:00Z"));
useRandom(() => 0.999);
// Sending open, as the operator opens it (beta-p1-040): a pass's reservation would be refused
// sending_closed on a fresh database.
beforeEach(() => openSending());
afterEach(() => useCampaignsClock(undefined));
const WORKSPACE = "wsp_campaigns_mode_safety";
const workspace = fixture(WORKSPACE);
const { app, run, account, enrolledLead, moveStep, dueAt, queue, itemOf } = workspace;
const { draftReady, approveItem, skipItem, decide, approved } = workspace;
const tenant = { workspaceId: WORKSPACE, principal: servicePrincipal("campaigns_test") };

/** The sender's order, reduced: the gate in the claim's run, then the reservation, on a pass only. */
const sendThroughGate = (accountId: string, stepId: string) =>
  run(async (tx) => {
    const answer = await checkGate(stepId, { at: new Date() });
    if (answer.pass) {
      const { actionType, idempotencyKey } = await tx.stepExecution.findFirstOrThrow({
        where: { id: stepId },
        select: { actionType: true, idempotencyKey: true },
      });
      const action = linkedinActionType({ id: stepId, actionType });
      const reservation = await reserveSend({ accountId, actionType: action, idempotencyKey });
      assert.ok("reservationId" in reservation, "a passed step is reserved");
    }
    return answer;
  });
const reservations = () => app().senderQuotaReservation.count();
const stepOf = (id: string) => app().stepExecution.findUniqueOrThrow({ where: { id } });
const draftOf = (id: string) =>
  app().messageDraft.findFirstOrThrow({ where: { stepExecutionId: id } });
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** The texts the writer leaves, each passing messaging's gates; the second a follow-up's. */
const FIRST = "Noor, how does your team follow up on warm leads today? A short question about it.";
const FOLLOW =
  "Noor, how does your team follow up on warm leads this week? A short question about it.";
/** messaging's LinkedIn line (its messages/en.json), after a blank line. */
const LINE = "Written with AI assistance and sent without a person's review.";
const PAST = new Date("2026-01-01T00:00:00Z");
const FUTURE = new Date(Date.now() + 2 * MS_PER_DAY);

/** The seeded campaign's mode and lock, as a change and the days going by leave them. */
async function campaignMode(approvalMode: string, reviewLockedUntil = PAST) {
  const where = { workspaceId: WORKSPACE, keyRef: TEMPLATE_ID };
  const data = { approvalMode: approvalMode as "review_first_touches", reviewLockedUntil };
  assert.equal((await app().campaign.updateMany({ where, data })).count, 1);
}
/** The step's draft ended `ready` with the text and attached: the mode's item approved by it. */
async function readyForMode(id: string, text: string) {
  const draft = await draftOf(id);
  await app().messageDraft.update({ where: { id: draft.id }, data: { status: "ready", text } });
  await run((tx) => attachStepDraft({ draftId: draft.id, stepExecutionId: id }, tx));
}
/** A lead whose connection request and first message went out, each approved by a person. */
async function contacted(slug: string) {
  const lead = await enrolledLead(slug);
  await approved(lead.steps.connect);
  await moveStep(lead.steps.connect, "succeeded");
  await dueAt(lead.steps.message_1, new Date());
  assert.equal(await queue(lead.steps.message_1), "opened");
  await draftReady(lead.steps.message_1, FIRST);
  await approveItem(lead.steps.message_1);
  assert.equal(await decide(lead.steps.message_1), "scheduled");
  await moveStep(lead.steps.message_1, "succeeded");
  return lead;
}
/**
 * A lead whose connection request went out and whose first message did not: its owner skipped it, or
 * it was approved and its send failed.
 */
async function firstMessageUnsent(slug: string, ending: "skipped" | "failed") {
  const lead = await enrolledLead(slug);
  await approved(lead.steps.connect);
  await moveStep(lead.steps.connect, "succeeded");
  await dueAt(lead.steps.message_1, new Date());
  assert.equal(await queue(lead.steps.message_1), "opened");
  await draftReady(lead.steps.message_1, FIRST);
  if (ending === "skipped") {
    await skipItem(lead.steps.message_1);
    assert.equal(await decide(lead.steps.message_1), "skipped");
  } else {
    await approveItem(lead.steps.message_1);
    assert.equal(await decide(lead.steps.message_1), "scheduled");
    const failed = { status: "failed", errorCode: "linkedin_input_invalid" } as const;
    await app().stepExecution.update({ where: { id: lead.steps.message_1 }, data: failed });
  }
  assert.equal((await stepOf(lead.steps.message_1)).status, ending);
  return lead;
}
/** The step's follow-up queued and, opened for the mode, approved by it: `scheduled`. */
async function modeApproved(id: string) {
  await dueAt(id, new Date());
  assert.equal(await queue(id), "opened");
  assert.equal((await itemOf(id))?.status, "pending");
  await readyForMode(id, FOLLOW);
  assert.equal(await decide(id), "scheduled");
  return itemOf(id);
}
/** The mode's approval written over the step's item, as approveByMode leaves one, its text frozen. */
async function plantModeApproval(id: string, body: string) {
  const item = await itemOf(id);
  assert.ok(item?.draftId);
  const frozen = `${body}\n\n${LINE}`;
  const draft = { status: "approved", approvedAt: new Date(), editedText: frozen } as const;
  await app().messageDraft.update({
    where: { id: item.draftId },
    data: { ...draft, disclosureApplied: true },
  });
  const byMode = { decisionOrigin: "approval_mode", approvalBy: "mode", decidedBy: null } as const;
  const decision = { status: "approved", approvedContentHash: sha256(frozen) } as const;
  await app().approvalItem.update({
    where: { id: item.id },
    data: { ...decision, ...byMode, decidedAt: new Date() },
  });
  return item.id;
}
/** The approval-mode route's body: the mode set in the workspace, then the switch back. */
const changeMode = (mode: string) =>
  run(
    async () => (await app().campaign.findFirstOrThrow({ where: { keyRef: TEMPLATE_ID } })).id,
  ).then((campaignId) => changeApprovalMode(tenant, campaignId, mode));

test("review_first_touches: a follow-up's item opens for the mode, which approves it with the AI disclosure line, and the gate passes it with the hash of the text and the line, the mode, the follow-up and the origin", async () => {
  const { id: accountId } = await account();
  const { steps } = await contacted("mode-safety-follow-up");
  await campaignMode("review_first_touches");
  // The first touches waited for a person (contacted); the follow-up's item is the mode's.
  const item = await modeApproved(steps.follow_up_1);
  const row = await app().approvalItem.findUniqueOrThrow({ where: { id: item?.id ?? "" } });
  assert.deepEqual(
    [row.approvalBy, row.status, row.decisionOrigin, row.decidedBy],
    ["mode", "approved", "approval_mode", null],
  );
  const draft = await draftOf(steps.follow_up_1);
  const frozen = `${FOLLOW}\n\n${LINE}`;
  assert.deepEqual([draft.editedText, draft.disclosureApplied], [frozen, true]);

  const answer = await sendThroughGate(accountId, steps.follow_up_1);
  assert.equal(answer.pass, true);
  assert.deepEqual(answer.checks.approval, {
    approvalItemId: row.id,
    status: "approved",
    contentHash: sha256(frozen),
    mode: "review_first_touches",
    firstTouch: false,
    origin: "approval_mode",
  });
  assert.equal(row.approvedContentHash, sha256(frozen), "the frozen hash covers the line");
  assert.equal(await reservations(), 1);
});

test("review_first_touches: a connection request and a first message each wait for a person; the mode's approval of a first message is refused not_approved, and approvals' table refuses it on a connection request; nothing reserved", async () => {
  const { id: accountId } = await account();
  const { steps } = await enrolledLead("mode-safety-first-touches");
  await campaignMode("review_first_touches");
  assert.equal(await queue(steps.connect), "opened");
  const invite = await itemOf(steps.connect);
  assert.ok(invite);
  const inviteRow = await app().approvalItem.findUniqueOrThrow({ where: { id: invite.id } });
  assert.equal(inviteRow.approvalBy, "person");
  // The mode never approves a connection request: approvals' CHECK refuses the row, even one
  // marked as opened for the mode.
  const byMode = { approvalBy: "mode", decisionOrigin: "approval_mode", decidedBy: null } as const;
  const refused = app().approvalItem.update({
    where: { id: invite.id },
    data: {
      ...{ status: "approved", approvedContentHash: sha256(""), decidedAt: new Date() },
      ...byMode,
    },
  });
  assert.equal(await sqlstate(refused), "23514");
  await approveItem(steps.connect);
  assert.equal(await decide(steps.connect), "scheduled");
  await moveStep(steps.connect, "succeeded");

  await dueAt(steps.message_1, new Date());
  assert.equal(await queue(steps.message_1), "opened");
  const first = await itemOf(steps.message_1);
  assert.ok(first);
  const firstRow = await app().approvalItem.findUniqueOrThrow({ where: { id: first.id } });
  assert.equal(firstRow.approvalBy, "person", "a first message waits for a person");
  await draftReady(steps.message_1, FIRST);
  assert.equal((await itemOf(steps.message_1))?.status, "pending", "the mode approves nothing");
  const planted = await plantModeApproval(steps.message_1, FIRST);
  assert.equal(await decide(steps.message_1), "scheduled");

  const answer = await sendThroughGate(accountId, steps.message_1);
  assert.deepEqual([answer.pass, !answer.pass && answer.reason], [false, "not_approved"]);
  assert.deepEqual(answer.checks.approval, {
    approvalItemId: planted,
    status: "approved",
    contentHash: null,
  });
  const step = await stepOf(steps.message_1);
  assert.deepEqual([step.status, step.skipReason], ["skipped", "not_approved"]);
  assert.equal(await reservations(), 0);
});

test("review_everything, and a campaign's first 7 days whatever its mode says: every follow-up's item waits for a person, and the mode's approval of one is refused not_approved, nothing reserved", async () => {
  const { id: accountId } = await account();
  for (const [slug, mode, lock] of [
    ["mode-safety-everything", "review_everything", PAST],
    ["mode-safety-locked", "review_first_touches", FUTURE],
  ] as const) {
    const { steps } = await contacted(slug);
    await campaignMode(mode, lock);
    await dueAt(steps.follow_up_1, new Date());
    assert.equal(await queue(steps.follow_up_1), "opened");
    const item = await itemOf(steps.follow_up_1);
    assert.ok(item);
    const row = await app().approvalItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(row.approvalBy, "person", slug);
    await draftReady(steps.follow_up_1, FOLLOW);
    assert.equal((await itemOf(steps.follow_up_1))?.status, "pending", slug);
    const planted = await plantModeApproval(steps.follow_up_1, FOLLOW);
    assert.equal(await decide(steps.follow_up_1), "scheduled");

    const answer = await sendThroughGate(accountId, steps.follow_up_1);
    assert.deepEqual([answer.pass, !answer.pass && answer.reason], [false, "not_approved"], slug);
    assert.deepEqual(answer.checks.approval, {
      approvalItemId: planted,
      status: "approved",
      contentHash: null,
    });
    const step = await stepOf(steps.follow_up_1);
    assert.deepEqual([step.status, step.skipReason], ["skipped", "not_approved"], slug);
  }
  assert.equal(await reservations(), 0);
});

test("the lock: an agent's campaign is in review_everything for 7 days from its creation; review_first_touches is refused approval_mode_locked with the lock's end until then, and taken at it; review_everything is taken always, and a repeat changes nothing", async () => {
  await workspace.owned();
  const T = new Date("2026-11-02T09:30:00Z");
  const end = new Date(T.getTime() + REVIEW_EVERYTHING_DAYS * MS_PER_DAY);
  useCampaignsClock(() => T);
  const input = { name: "Agent", ownerUserId: APPROVER, createdBy: "system", playbookId: "pbk_1" };
  const { campaignId } = await run(() => createCampaign(input));
  const row = () => app().campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const made = await row();
  assert.deepEqual(
    [made.approvalMode, made.reviewLockedUntil, made.approvalModeSetBy, made.approvalModeSetAt],
    ["review_everything", end, null, null],
  );

  useCampaignsClock(() => new Date(end.getTime() - 1));
  await assert.rejects(changeApprovalMode(tenant, campaignId, "review_first_touches"), {
    code: "approval_mode_locked",
    status: 409,
    details: { lockedUntil: end.toISOString() },
  });
  assert.deepEqual(await row(), made, "a refusal writes nothing");
  const everything = await changeApprovalMode(tenant, campaignId, "review_everything");
  assert.deepEqual(everything, {
    mode: "review_everything",
    effectiveMode: "review_everything",
    lockedUntil: end,
  });
  assert.deepEqual(await row(), made, "the same mode again writes nothing");
  await assert.rejects(changeApprovalMode(tenant, campaignId, "review_exceptions"), {
    code: "approval_mode_unavailable",
    status: 400,
  });

  useCampaignsClock(() => end);
  const lighter = await changeApprovalMode(tenant, campaignId, "review_first_touches");
  assert.deepEqual(lighter, {
    mode: "review_first_touches",
    effectiveMode: "review_first_touches",
    lockedUntil: end,
  });
  const set = await row();
  assert.deepEqual(
    [set.approvalMode, set.reviewLockedUntil, set.approvalModeSetBy, set.approvalModeSetAt],
    ["review_first_touches", end, tenant.principal.userId, end],
  );
  useCampaignsClock(() => new Date(end.getTime() + MS_PER_DAY));
  await changeApprovalMode(tenant, campaignId, "review_first_touches");
  assert.deepEqual(await row(), set, "a repeat changes nothing, the lock included");
});

test("the switch back: back to review_everything, every step of the mode's, scheduled or waiting, goes back to planned with its item blocked and its draft ready without the line; a person approves it before it goes; a step the person approved stays; the gate refuses the mode's approval of a step the switch back did not reach", async () => {
  const { id: accountId } = await account();
  const scheduled = await contacted("mode-safety-back-scheduled");
  const waiting = await contacted("mode-safety-back-waiting");
  const person = await contacted("mode-safety-back-person");
  const claimed = await contacted("mode-safety-back-claimed");
  await campaignMode("review_first_touches");
  const modeItem = await modeApproved(scheduled.steps.follow_up_1);
  assert.ok(modeItem);
  // Opened for the mode, its draft still being written.
  await dueAt(waiting.steps.follow_up_1, new Date());
  assert.equal(await queue(waiting.steps.follow_up_1), "opened");
  const waitingItem = await itemOf(waiting.steps.follow_up_1);
  // A person approved this one: its item opened for the mode, which declined its flagged draft.
  await dueAt(person.steps.follow_up_1, new Date());
  assert.equal(await queue(person.steps.follow_up_1), "opened");
  const flagged = await draftOf(person.steps.follow_up_1);
  const flag = { status: "flagged", text: FOLLOW } as const;
  await app().messageDraft.update({ where: { id: flagged.id }, data: flag });
  const ended = { draftId: flagged.id, stepExecutionId: person.steps.follow_up_1 };
  await run((tx) => attachStepDraft(ended, tx));
  const declined = await itemOf(person.steps.follow_up_1);
  assert.equal(declined?.status, "pending", "the mode leaves a flagged draft to a person");
  await approveItem(person.steps.follow_up_1);
  assert.equal(await decide(person.steps.follow_up_1), "scheduled");
  // The sender has claimed this one: the switch back leaves it to the gate.
  await modeApproved(claimed.steps.follow_up_1);
  await moveStep(claimed.steps.follow_up_1, "executing");

  const answer = await changeMode("review_everything");
  assert.equal(answer.effectiveMode, "review_everything");
  for (const id of [scheduled.steps.follow_up_1, waiting.steps.follow_up_1]) {
    const step = await stepOf(id);
    assert.deepEqual(
      [step.status, step.approvalItemId, step.draftId, step.scheduledFor, step.quotaDay],
      ["planned", null, null, null, null],
    );
  }
  const blocked = await app().approvalItem.findUniqueOrThrow({ where: { id: modeItem.id } });
  assert.deepEqual(
    [blocked.status, blocked.approvedContentHash, blocked.decisionOrigin, blocked.decidedAt],
    ["blocked", null, null, null],
  );
  assert.equal((await itemOf(waiting.steps.follow_up_1))?.id, waitingItem?.id);
  assert.equal((await itemOf(waiting.steps.follow_up_1))?.status, "blocked");
  const reopened = await draftOf(scheduled.steps.follow_up_1);
  assert.deepEqual(
    [reopened.status, reopened.text, reopened.editedText, reopened.disclosureApplied],
    ["ready", FOLLOW, null, false],
  );
  assert.equal((await stepOf(person.steps.follow_up_1)).status, "scheduled");
  assert.equal((await stepOf(claimed.steps.follow_up_1)).status, "executing");

  // The queue opens a new item, for a person, its draft attached at once; nothing goes before it.
  const back = scheduled.steps.follow_up_1;
  assert.equal(await queue(back), "opened");
  const fresh = await itemOf(back);
  assert.ok(fresh && fresh.id !== modeItem.id);
  const freshRow = await app().approvalItem.findUniqueOrThrow({ where: { id: fresh.id } });
  assert.deepEqual([freshRow.approvalBy, freshRow.status], ["person", "pending"]);
  assert.equal(freshRow.draftId, reopened.id);
  await approveItem(back);
  assert.equal(await decide(back), "scheduled");
  const sent = await sendThroughGate(accountId, back);
  assert.equal(sent.pass, true);
  assert.deepEqual(sent.checks.approval, {
    approvalItemId: fresh.id,
    status: "approved",
    contentHash: sha256(FOLLOW),
    mode: "review_everything",
    firstTouch: false,
    origin: "app",
  });

  // The backstop: the claimed step's mode approval no longer passes.
  const late = await sendThroughGate(accountId, claimed.steps.follow_up_1);
  assert.deepEqual([late.pass, !late.pass && late.reason], [false, "not_approved"]);
  assert.equal(await reservations(), 1, "only the person's approval was reserved");
  // A repeat finds nothing of the mode's left, and changes nothing.
  const before = await app().stepExecution.findMany({ orderBy: { id: "asc" } });
  await changeMode("review_everything");
  assert.deepEqual(await app().stepExecution.findMany({ orderBy: { id: "asc" } }), before);
});

test("review_first_touches: a follow-up whose first message did not go out, skipped by its owner or failed, is the lead's first message: its item opens for a person, and the gate refuses the mode's approval of it not_approved, the step skipped and nothing reserved; a person's approval passes it as a first touch", async () => {
  const { id: accountId } = await account();
  for (const ending of ["skipped", "failed"] as const) {
    const { steps } = await firstMessageUnsent(`mode-safety-unsent-${ending}`, ending);
    await campaignMode("review_first_touches");
    await dueAt(steps.follow_up_1, new Date());
    assert.equal(await queue(steps.follow_up_1), "opened", ending);
    const item = await itemOf(steps.follow_up_1);
    assert.ok(item, ending);
    const row = await app().approvalItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(row.approvalBy, "person", `${ending}: the item is a person's`);
    await draftReady(steps.follow_up_1, FOLLOW);
    const waiting = (await itemOf(steps.follow_up_1))?.status;
    assert.equal(waiting, "pending", `${ending}: the mode approves nothing`);
    // The mode's approval, as an item opened for the mode before the fix would hold it.
    const planted = await plantModeApproval(steps.follow_up_1, FOLLOW);
    assert.equal(await decide(steps.follow_up_1), "scheduled");

    const answer = await sendThroughGate(accountId, steps.follow_up_1);
    const refused = [answer.pass, !answer.pass && answer.reason];
    assert.deepEqual(refused, [false, "not_approved"], ending);
    assert.deepEqual(answer.checks.approval, {
      approvalItemId: planted,
      status: "approved",
      contentHash: null,
    });
    const step = await stepOf(steps.follow_up_1);
    assert.deepEqual([step.status, step.skipReason], ["skipped", "not_approved"], ending);
  }
  assert.equal(await reservations(), 0);

  // A person reads it: their approval passes, the gate's checks naming a first touch.
  const { steps } = await firstMessageUnsent("mode-safety-unsent-person", "skipped");
  await dueAt(steps.follow_up_1, new Date());
  assert.equal(await queue(steps.follow_up_1), "opened");
  await draftReady(steps.follow_up_1, FOLLOW);
  const itemId = await approveItem(steps.follow_up_1);
  assert.equal(await decide(steps.follow_up_1), "scheduled");
  const sent = await sendThroughGate(accountId, steps.follow_up_1);
  assert.equal(sent.pass, true);
  assert.deepEqual(sent.checks.approval, {
    approvalItemId: itemId,
    status: "approved",
    contentHash: sha256(FOLLOW),
    mode: "review_first_touches",
    firstTouch: true,
    origin: "app",
  });
  assert.equal(await reservations(), 1);
});

test("review_first_touches: a follow-up whose enrollment, or whose own row in it, the read does not find needs a person's approval, a first touch whatever its version says", async () => {
  await account();
  const { steps } = await contacted("mode-safety-unknown");
  const other = await contacted("mode-safety-unknown-other");
  await campaignMode("review_first_touches");
  const row = await stepOf(steps.follow_up_1);
  const { id, enrollmentId, templateId, templateVersion, stepKey, actionType } = row;
  const step = { id, enrollmentId, templateId, templateVersion, stepKey, actionType };
  const at = new Date();
  // The control: its first message went out, so the mode may approve it.
  const followUp = { mode: "review_first_touches", firstTouch: false, required: "person_or_mode" };
  assert.deepEqual(await run(() => stepRequirement(step, at)), followUp);
  const person = { mode: "review_first_touches", firstTouch: true, required: "person" };
  const unknown = [
    { enrollmentId: "enl_missing" },
    { enrollmentId: "" },
    { enrollmentId: undefined as unknown as string },
    { id: "sx_missing" },
    { id: "" },
    { id: undefined as unknown as string },
    // Another enrollment's history, which does not hold the step.
    { enrollmentId: other.enrollmentId },
  ];
  for (const missing of unknown) {
    const answer = await run(() => stepRequirement({ ...step, ...missing }, at));
    assert.deepEqual(answer, person, JSON.stringify(missing));
  }
});
