// The approval mode's rules (gamma-p4-070; README.md "The approval mode"): the effective mode at the
// lock's edge, whose approval each step needs in each mode, which steps are first touches (by the
// version, and by the enrollment's sends, review-gaps), failing closed each, and the lock set from a
// campaign's creation, on the worktree's database in this file's
// schema. The gate's, the queue's and the switch back's cases are tests/safety/approval-mode.test.ts.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { REVIEW_EVERYTHING_DAYS } from "../domain/approval-mode/constants.ts";
import {
  effectiveMode,
  isApprovalMode,
  modeOf,
  reviewLockedUntilOf,
} from "../domain/approval-mode/mode.ts";
import { stepRequirement } from "../domain/approval-mode/requirement.ts";
import { createCampaign, seedCampaign } from "../domain/campaigns/commands.ts";
import { FIRST_MESSAGE_DELAY } from "../domain/campaigns/constants.ts";
import { keyedSteps, validateSequence } from "../domain/campaigns/sequence.ts";
import { useClock } from "../domain/clock.ts";
import { MS_PER_DAY } from "../domain/constants.ts";
import { approvalRequired, isFirstTouch } from "../domain/steps/actions.ts";
import { TEMPLATE_ID } from "../domain/template/constants.ts";
import { WARM_SIGNAL_STEPS } from "../domain/template/warm-signal.ts";
import { APPROVER, fixture } from "./fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
afterEach(() => useClock(undefined));
const { app, run, owned, account, enrolledLead, moveStep } = fixture("wsp_campaigns_approval_mode");
const LOCK = new Date("2026-11-09T09:30:00Z");
const before = new Date(LOCK.getTime() - 1);
const lighter = { approvalMode: "review_first_touches", reviewLockedUntil: LOCK };

test("the effective mode is review_everything until the lock ends, whatever the campaign's says, then its own; an unknown mode or an instant that is no time reads as review_everything", () => {
  assert.equal(effectiveMode(lighter, before), "review_everything");
  assert.equal(effectiveMode(lighter, LOCK), "review_first_touches");
  assert.equal(
    effectiveMode({ ...lighter, approvalMode: "review_everything" }, LOCK),
    "review_everything",
  );
  assert.equal(
    effectiveMode({ ...lighter, approvalMode: "review_exceptions" }, LOCK),
    "review_everything",
  );
  assert.equal(effectiveMode(lighter, new Date(Number.NaN)), "review_everything");
  assert.equal(
    effectiveMode({ ...lighter, reviewLockedUntil: new Date(Number.NaN) }, LOCK),
    "review_everything",
  );
  assert.deepEqual(modeOf({ ...lighter, approvalMode: "review_first_touches" }, before), {
    mode: "review_first_touches",
    effectiveMode: "review_everything",
    lockedUntil: LOCK,
  });
  assert.deepEqual(
    ["review_everything", "review_first_touches", "review_exceptions", "", 1, null].map(
      isApprovalMode,
    ),
    [true, true, false, false, false, false],
  );
  assert.deepEqual(reviewLockedUntilOf(LOCK), new Date(LOCK.getTime() + 7 * MS_PER_DAY));
});

test("whose approval a step needs: none for a withdrawal; a person's in review_everything, for a first touch, and for any other action or mode; a person's or the mode's for a LinkedIn or an email follow-up in review_first_touches", () => {
  const modes = ["review_everything", "review_first_touches", "review_exceptions", ""];
  const cases = [
    [{ actionType: "invite", firstTouch: true }, ["person", "person", "person", "person"]],
    [{ actionType: "invite", firstTouch: false }, ["person", "person", "person", "person"]],
    [{ actionType: "message", firstTouch: true }, ["person", "person", "person", "person"]],
    [
      { actionType: "message", firstTouch: false },
      ["person", "person_or_mode", "person", "person"],
    ],
    [{ actionType: "email", firstTouch: true }, ["person", "person", "person", "person"]],
    [{ actionType: "email", firstTouch: false }, ["person", "person_or_mode", "person", "person"]],
    [{ actionType: "inmail", firstTouch: false }, ["person", "person", "person", "person"]],
    [{ actionType: "", firstTouch: false }, ["person", "person", "person", "person"]],
    [{ actionType: "withdraw", firstTouch: false }, ["none", "none", "none", "none"]],
  ] as const;
  for (const [step, expected] of cases) {
    assert.deepEqual(
      modes.map((mode) => approvalRequired(step, mode)),
      expected,
      `${step.actionType} ${step.firstTouch}`,
    );
  }
});

test("a first touch is the first step of its action in its version: the connection request, the first message and the first email; a key the version lacks, another action under the key, or no version at all is one", () => {
  const steps = keyedSteps(validateSequence(WARM_SIGNAL_STEPS));
  // Every step of the enrollment sent: only the version's order decides.
  const sent = steps.map(({ stepKey, action }) => ({
    ...{ id: stepKey, actionType: action, status: "succeeded" },
  }));
  const first = (stepKey: string, actionType: string, version = steps, enrolled = sent) =>
    isFirstTouch({ id: stepKey, stepKey, actionType }, version, enrolled);
  assert.deepEqual(
    steps.map(({ stepKey, action }) => [stepKey, first(stepKey, action)]),
    [
      ["connect", true],
      ["message_1", true],
      ["follow_up_1", false],
      ["follow_up_2", false],
      ["email_1", true],
      ["email_2", false],
      ["email_3", false],
    ],
  );
  assert.equal(first("follow_up_3", "message"), true);
  assert.equal(first("follow_up_1", "email"), true);
  assert.equal(first("follow_up_1", "message", []), true);
  assert.equal(isFirstTouch({ id: "f", stepKey: "follow_up_1", actionType: "message" }), true);
  // An email between the messages: each action's own order decides.
  const after = (value: number) => ({ anchor: "prev_step", unit: "business_days", value }) as const;
  const mixed = keyedSteps(
    validateSequence([
      { action: "invite", delay: { anchor: "enrollment" } },
      { action: "message", delay: FIRST_MESSAGE_DELAY },
      { action: "email", delay: after(2) },
      { action: "message", delay: after(4) },
    ]),
  );
  const mixedSent = mixed.map(({ stepKey, action }) => ({
    ...{ id: stepKey, actionType: action, status: "succeeded" },
  }));
  assert.deepEqual(
    mixed.map(({ stepKey, action }) => [stepKey, first(stepKey, action, mixed, mixedSent)]),
    [
      ["connect", true],
      ["message_1", true],
      ["email_1", true],
      ["follow_up_1", false],
    ],
  );
});

test("review-gaps: a follow-up is a first touch until another step of its action in its enrollment has succeeded: skipped, failed, held, cancelled, planned, scheduled and executing do not count, nor another action's send; no enrollment, or one without the step, is a first touch; the version's first of an action is one whatever was sent", () => {
  const steps = keyedSteps(validateSequence(WARM_SIGNAL_STEPS));
  const enrolled = (
    message1: string,
    extra: { id: string; actionType: string; status: string }[] = [],
  ) =>
    [
      ...steps.map(({ stepKey, action }) => ({
        id: stepKey,
        actionType: action,
        status: "planned",
      })),
      ...extra,
    ].map((row) => (row.id === "message_1" ? { ...row, status: message1 } : row));
  const followUp1 = { id: "follow_up_1", stepKey: "follow_up_1", actionType: "message" };
  const unsent = [
    "skipped",
    "failed",
    "held",
    "cancelled",
    "planned",
    "awaiting_approval",
    "scheduled",
    "executing",
  ];
  for (const status of unsent) {
    assert.equal(isFirstTouch(followUp1, steps, enrolled(status)), true, status);
  }
  assert.equal(isFirstTouch(followUp1, steps, enrolled("succeeded")), false);
  // A sent connection request or email is no message the person received.
  const others = enrolled("skipped").map((row) =>
    row.actionType === "message" ? row : { ...row, status: "succeeded" },
  );
  assert.equal(isFirstTouch(followUp1, steps, others), true);
  // follow_up_2 after a sent follow_up_1, its first message skipped: a follow-up.
  const afterFollowUp = enrolled("skipped").map((row) =>
    row.id === "follow_up_1" ? { ...row, status: "succeeded" } : row,
  );
  const followUp2 = { id: "follow_up_2", stepKey: "follow_up_2", actionType: "message" };
  assert.equal(isFirstTouch(followUp2, steps, afterFollowUp), false);
  // Its own success counts for nothing: another step must have gone out.
  const self = enrolled("skipped").map((row) =>
    row.id === "follow_up_1" ? { ...row, status: "succeeded" } : row,
  );
  assert.equal(isFirstTouch(followUp1, steps, self), true);
  // Unknown: no enrollment, or one that does not hold the step.
  assert.equal(isFirstTouch(followUp1, steps, null), true);
  assert.equal(isFirstTouch(followUp1, steps), true);
  const elsewhere = enrolled("succeeded").filter(({ id }) => id !== "follow_up_1");
  assert.equal(isFirstTouch(followUp1, steps, elsewhere), true);
  // The version's first message is a first touch, a later one sent or not.
  const message1 = { id: "message_1", stepKey: "message_1", actionType: "message" };
  assert.equal(isFirstTouch(message1, steps, afterFollowUp), true);
});

test("a step of a campaign, a version or an enrollment the workspace lacks needs a person's approval: review_everything, a first touch; a follow-up after a sent first message may take the mode's", async () => {
  await account();
  const lead = await enrolledLead("approval-mode-requirement");
  await moveStep(lead.steps.message_1, "succeeded");
  const row = await app().stepExecution.findUniqueOrThrow({
    where: { id: lead.steps.follow_up_1 },
  });
  const { id, enrollmentId, templateVersion, stepKey } = row;
  const step = { id, enrollmentId, templateId: "cmp_missing", templateVersion, stepKey };
  const answer = await run(() => stepRequirement({ ...step, actionType: "message" }, LOCK));
  assert.deepEqual(answer, { mode: "review_everything", firstTouch: true, required: "person" });
  const lifted = { approvalMode: "review_first_touches", reviewLockedUntil: before } as const;
  await app().campaign.updateMany({ where: { keyRef: TEMPLATE_ID }, data: lifted });
  const known = { ...step, templateId: TEMPLATE_ID, actionType: "message" };
  assert.deepEqual(await run(() => stepRequirement(known, LOCK)), {
    mode: "review_first_touches",
    firstTouch: false,
    required: "person_or_mode",
  });
  const person = { mode: "review_first_touches", firstTouch: true, required: "person" };
  for (const missing of [{ templateVersion: 9 }, { enrollmentId: "enl_missing" }]) {
    const answered = await run(() => stepRequirement({ ...known, ...missing }, LOCK));
    assert.deepEqual(answered, person, JSON.stringify(missing));
  }
});

test("the lock is set from a campaign's creation, the seeded one's and a made one's: review_everything for REVIEW_EVERYTHING_DAYS, no one has set it; the table refuses a setter without a time", async () => {
  await owned();
  const T = new Date("2026-11-02T09:30:00Z");
  const end = new Date(T.getTime() + REVIEW_EVERYTHING_DAYS * MS_PER_DAY);
  useClock(() => T);
  const seeded = await run(() => seedCampaign());
  assert.ok(seeded);
  const input = { name: "Warm leads", ownerUserId: APPROVER, createdBy: APPROVER };
  const { campaignId } = await run(() => createCampaign(input));
  for (const id of [seeded.id, campaignId]) {
    const row = await app().campaign.findUniqueOrThrow({ where: { id } });
    assert.deepEqual(
      [row.approvalMode, row.reviewLockedUntil, row.approvalModeSetBy, row.approvalModeSetAt],
      ["review_everything", end, null, null],
    );
  }
  assert.deepEqual([seeded.approvalMode, seeded.reviewLockedUntil], ["review_everything", end]);
  const half = app().campaign.update({
    where: { id: campaignId },
    data: { approvalModeSetBy: APPROVER },
  });
  assert.equal(await sqlstate(half), "23514");
});
