// The settle of a send that went out (beta-p4-020; README.md "Worker", docs/flows.md "The sender",
// step 8), on a schema of the worktree's database, in tenant runs as the sender's: each step claimed
// as the claim leaves it, under the slot linkedin's reserveSend made for its key, and settled sent
// with no credits. The next step falls due in Monday-to-Friday business days in the sender's zone,
// Paris, across a weekend and the end of summer time; the last step completes the enrollment and
// finishes the lead, once: a repeat of the settle changes nothing.
import assert from "node:assert/strict";
import test from "node:test";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { reserveSend } from "@whytide/linkedin";
import { openSending, useClock, useLinkedinClient } from "@whytide/linkedin/testing";
import { settleSend } from "../domain/send/settle.ts";
import { linkedinActionType } from "../domain/steps/actions.ts";
import type { StepKey } from "../domain/template/constants.ts";
import { fixture } from "./fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
const { app, run, account, enrolledLead, enrollmentOf, leadOf } = fixture("wsp_campaigns_settle");

test("a send settled: the next step due in business days in the sender's zone across a weekend and a daylight-saving change; the last step completes the enrollment and finishes the lead, once", async () => {
  const { id: accountId } = await account("Europe/Paris");
  await openSending();
  const lead = await enrolledLead("settle-due");
  const stepOf = (key: StepKey) =>
    app().stepExecution.findUniqueOrThrow({ where: { id: lead.steps[key] } });
  /** The step claimed and its slot reserved at `at`, then settled sent at `at`. */
  async function sent(key: StepKey, at: Date) {
    const step = await stepOf(key);
    await app().stepExecution.update({
      where: { id: step.id },
      data: { status: "executing", attempt: 1 },
    });
    useClock(() => at);
    const { idempotencyKey } = step;
    const actionType = linkedinActionType(step);
    const slot = await run(() =>
      reserveSend({ accountId, actionType, idempotencyKey, withNote: false }),
    );
    assert.ok("reservationId" in slot, JSON.stringify(slot));
    const holds = { usageId: null, reservationId: slot.reservationId };
    const answer = { sent: true, stepExecutionId: step.id } as const;
    return run(() => settleSend({ stepExecutionId: step.id, holds, answer }, at));
  }
  await app().stepExecution.update({
    where: { id: lead.steps.connect },
    data: { status: "succeeded", executedAt: new Date("2026-10-20T08:00:00Z") },
  });

  // Thursday 10:00 in Paris, summer time: three business days on is Tuesday 10:00, winter time.
  await sent("message_1", new Date("2026-10-22T08:00:00Z"));
  assert.equal((await stepOf("follow_up_1")).dueAt?.toISOString(), "2026-10-27T09:00:00.000Z");
  assert.equal((await stepOf("follow_up_2")).dueAt, null);
  // Five business days after Tuesday is the next Tuesday.
  await sent("follow_up_1", new Date("2026-10-27T09:00:00Z"));
  assert.equal((await stepOf("follow_up_2")).dueAt?.toISOString(), "2026-11-03T09:00:00.000Z");

  const at = new Date("2026-11-03T09:00:00Z");
  const settled = await sent("follow_up_2", at);
  assert.deepEqual(settled, { outcome: "sent", end: false, uncharged: null });
  const done = await stepOf("follow_up_2");
  assert.deepEqual([done.status, done.executedAt?.getTime()], ["succeeded", at.getTime()]);
  const enrollment = await enrollmentOf(lead.enrollmentId);
  assert.deepEqual([enrollment.status, enrollment.endedAt?.getTime()], ["completed", at.getTime()]);
  const finished = await leadOf(lead.personId);
  assert.equal(finished.status, "finished");

  // A repeat of the settle, as a retried activity makes one: nothing more is written.
  const repeat = { usageId: null, reservationId: "" };
  const reservation = await app().senderQuotaReservation.findFirstOrThrow({
    where: { idempotencyKey: done.idempotencyKey },
  });
  const answer = { sent: true, stepExecutionId: done.id } as const;
  const holds = { ...repeat, reservationId: reservation.id };
  await run(() => settleSend({ stepExecutionId: done.id, holds, answer }, new Date()));
  assert.deepEqual(await leadOf(lead.personId), finished);
  assert.equal((await stepOf("follow_up_2")).executedAt?.getTime(), at.getTime());
  const events = await app().outboxEntry.count({ where: { eventName: "campaigns.step_sent" } });
  assert.equal(events, 3);
});
