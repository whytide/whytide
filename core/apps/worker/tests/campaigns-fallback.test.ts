// campaigns' email fallback end to end (gamma-p3-060; core/modules/campaigns/README.md "The
// fallback"), on the LinkedIn fake, the slice's Temporal and a schema of its database
// (fixtures/campaigns-sender.ts, fixtures/campaigns-withdraw.ts): a lead enrolled by the subscriber's
// body on the seeded campaign's warm-signal version, its connection request sent through the plan
// and the sender, the first fallback email due 7 days after it went out; an acceptance skips the
// three emails and the LinkedIn messages go on to the queue; with none, the day-21 withdrawal cancels
// the LinkedIn steps and keeps the fallback, and the enrollment ends after its last fallback email,
// exited not_accepted. Nothing sends an email before gamma-p4-010: the emails are moved here as its
// sender will move them. The safety cases are campaigns' tests/safety/fallback.test.ts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { newId } from "@whytide/platform";
import {
  app,
  contacts,
  DAY_MS,
  now,
  OWNER,
  type Sender,
  sender,
  useSenderTests,
} from "./fixtures/campaigns-sender.ts";
import { endOf, leadOf, moveTo, withdrawRun } from "./fixtures/campaigns-withdraw.ts";

const built = (path: string) => import(new URL(`../../../modules/${path}`, import.meta.url).href);
const { saveVersion, seedCampaign } = await built("campaigns/dist/domain/campaigns/commands.js");
const { WARM_SIGNAL_STEPS } = await built("campaigns/dist/domain/template/warm-signal.js");
const { enrollApproved } = await built("campaigns/dist/domain/enroll/enroll.js");
const { recordAcceptance } = await built("campaigns/dist/domain/acceptance.js");
const { SKIPPED_STEP_FIELDS, skipStep } = await built("campaigns/dist/domain/steps/skip.js");

useSenderTests();
const MINUTE_MS = 60_000;
const LINKEDIN = ["connect", "message_1", "follow_up_1", "follow_up_2"];

/**
 * The seeded campaign's current version made the warm signal by the workspace's Owner, a person
 * approved and enrolled on it by the subscriber's body, and their connection request approved,
 * placed and sent by the sender: the person, the enrollment, the steps by key and the send's time.
 */
async function invitedWarm(s: Sender, slug: string) {
  const owner = await app.membership.findFirstOrThrow({ where: { workspaceId: s.workspaceId } });
  const seeded: { id: string } = await s.run(() => seedCampaign());
  await s.run(() => saveVersion(seeded.id, WARM_SIGNAL_STEPS, { createdBy: owner.userId }));
  const memberRef = `member-${randomUUID()}`;
  const personId: string = await s.run(async () => {
    const linkedinUrl = `https://linkedin.com/in/${slug}-${randomUUID().slice(0, 8)}`;
    const profile = { linkedinUrl, providerId: memberRef, firstName: "Noor" };
    const { person } = await contacts.upsertPersonFromSource({
      ...{ source: "linkedin", provider: "unipile", profile },
    });
    await contacts.createLeadForPerson({
      ...{ personId: person.id, source: { kind: "imported", ref: "imp_1" } },
    });
    await contacts.recordLeadStatus(person.id, "approved", { actor: { type: "user", id: OWNER } });
    return person.id;
  });
  const approval = { sourceEventId: newId("obx"), personId, approvedBy: OWNER };
  assert.equal(await s.run((tx) => enrollApproved(tx, approval)), "enrolled");
  const rows = await app.stepExecution.findMany({ where: { personId } });
  const ids = new Map(rows.map((row) => [row.stepKey, row.id]));
  const id = (key: string): string => ids.get(key) ?? assert.fail(`no step ${key}`);
  const enrollmentId = rows[0]?.enrollmentId ?? "";
  await s.approve(id("connect"), "");
  await s.place(id("connect"));
  assert.equal((await s.send()).result.sent, 1);
  const connect = await app.stepExecution.findUniqueOrThrow({ where: { id: id("connect") } });
  assert.ok(connect.status === "succeeded" && connect.executedAt);
  return { personId, enrollmentId, id, sentAt: connect.executedAt };
}

const dueOf = async (id: string) =>
  (await app.stepExecution.findUniqueOrThrow({ where: { id } })).dueAt?.getTime() ?? null;

test("sent through the sender, the connection request makes the first fallback email due 7 days later; an acceptance then skips the three emails and the LinkedIn messages go on to the queue", async () => {
  const s = await sender();
  const lead = await invitedWarm(s, "fallback-accepted");
  const { id, sentAt } = lead;
  assert.deepEqual(
    [await dueOf(id("email_1")), await dueOf(id("email_2")), await dueOf(id("email_3"))],
    [sentAt.getTime() + 7 * DAY_MS, null, null],
  );

  // The next day, a Friday: message_1 falls due inside the weekdays.
  moveTo(new Date(sentAt.getTime() + DAY_MS));
  const accepted = { senderAccountId: s.accountId, personId: lead.personId, detectedAt: now() };
  assert.equal(await s.run((tx) => recordAcceptance(tx, accepted)), "due");
  const { enrollment, steps: outcome } = await endOf(lead.enrollmentId);
  assert.deepEqual(enrollment, ["active", null]);
  assert.deepEqual(outcome, {
    ...{ connect: ["succeeded", null], message_1: ["planned", null] },
    ...{ follow_up_1: ["planned", null], follow_up_2: ["planned", null] },
    email_1: ["skipped", "invite_accepted"],
    email_2: ["skipped", "invite_accepted"],
    email_3: ["skipped", "invite_accepted"],
  });
  // message_1 falls due within 3 hours: the queue's next run lists it, and no email.
  moveTo(new Date(now().getTime() + 3 * 3_600_000));
  const queued = await s.call("campaigns_due_steps", { workspaceId: s.workspaceId });
  // The tick's only page, so no next one (gamma-p0-085).
  assert.deepEqual(queued, { stepIds: [id("message_1")], next: null });
});

test("never accepted: the day-21 withdrawal cancels the LinkedIn steps and keeps the pending fallback, and the enrollment ends after its last fallback email, exited not_accepted, the lead finished", async () => {
  const s = await sender();
  const lead = await invitedWarm(s, "fallback-never");
  const { id, sentAt } = lead;
  // Day 7: email_1 due, which no queue run lists before gamma-p4-010.
  moveTo(new Date(sentAt.getTime() + 7 * DAY_MS + MINUTE_MS));
  assert.deepEqual(await s.call("campaigns_due_steps", { workspaceId: s.workspaceId }), {
    stepIds: [],
    next: null,
  });

  moveTo(new Date(sentAt.getTime() + 21 * DAY_MS + MINUTE_MS));
  assert.deepEqual(await withdrawRun(s), { opened: 1 });
  assert.deepEqual(await s.plan(), { accounts: 1, placed: 1 });
  assert.deepEqual((await s.send()).result, { sent: 1, blocked: 0, refused: 0, end: "no_step" });
  const withdrawn = await endOf(lead.enrollmentId);
  assert.deepEqual(withdrawn.enrollment, ["active", null], "a fallback email is still pending");
  const linkedin = Object.fromEntries(LINKEDIN.map((key) => [key, withdrawn.steps[key]]));
  assert.deepEqual(linkedin, {
    connect: ["succeeded", null],
    message_1: ["cancelled", "not_accepted"],
    follow_up_1: ["cancelled", "not_accepted"],
    follow_up_2: ["cancelled", "not_accepted"],
  });
  assert.deepEqual(withdrawn.steps.withdraw, ["succeeded", null]);
  for (const key of ["email_1", "email_2", "email_3"]) {
    assert.deepEqual(withdrawn.steps[key], ["planned", null], key);
  }
  assert.equal(await leadOf(lead.personId), "in_campaign");

  // email_1 and email_2 sent as gamma-p4-010's sender will leave them; email_3, the last step,
  // skipped by its owner: nothing of the enrollment is open, so it ends.
  for (const key of ["email_1", "email_2"]) {
    const sent = { status: "succeeded", executedAt: now() } as const;
    await app.stepExecution.update({ where: { id: id(key) }, data: sent });
  }
  await app.stepExecution.update({ where: { id: id("email_3") }, data: { status: "scheduled" } });
  const last = await app.stepExecution.findUniqueOrThrow({
    where: { id: id("email_3") },
    select: SKIPPED_STEP_FIELDS,
  });
  const skip = { reason: "skipped_by_owner", at: now(), actor: { type: "user", id: OWNER } };
  assert.equal(await s.run((tx) => skipStep(tx, last, skip)), true);
  const ended = await endOf(lead.enrollmentId);
  assert.deepEqual(ended.enrollment, ["exited", "not_accepted"]);
  assert.deepEqual(ended.steps.email_3, ["skipped", "skipped_by_owner"]);
  assert.equal(await leadOf(lead.personId), "finished");
});
