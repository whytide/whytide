// The safety cases of a person without a LinkedIn profile (gamma-rf-050; README.md "Reason codes";
// docs/flows.md "The sender"), run by `pnpm -F campaigns test:safety` and not by `test`, on the
// worktree's database in this file's schema, sending open: no LinkedIn step of a person known by an
// email address alone reaches LinkedIn. A connection request whose person has no member id reserves
// no profile read; a connection request, a message or a withdrawal writes no request, even with a
// member id: each fails with no_linkedin_profile, its slot freed, its enrollment exited (send_refused,
// the code as its detail), its other steps cancelled and the lead finished; a check builds no request
// for one and keeps its holds. The control: a person with a profile has the read reserved and the request
// built. No credits are bound in a module's test: the worker's test frees them
// (core/apps/worker/tests/campaigns-recovery.test.ts).
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { reserveSend } from "@whytide/linkedin";
import { openSending, useClock, useLinkedinClient, useRandom } from "@whytide/linkedin/testing";
import { prepareRequest } from "../../domain/send/prepare.ts";
import { reserveProfileRead } from "../../domain/send/profile.ts";
import { fixture } from "../fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
// linkedin's reservations read its own clock: a Wednesday morning, inside the account's hours.
const AT = new Date("2026-10-28T10:00:00Z");
useClock(() => AT);
useRandom(() => 0.999);
// Sending open, as the operator opens it (beta-p1-040): a fresh database has it closed.
beforeEach(() => openSending());
const WORKSPACE = "wsp_campaigns_no_profile_safety";
const { app, run, account, enrolledLead, moveStep, stepsOf, enrollmentOf, leadOf, approved } =
  fixture(WORKSPACE);
const CODE = "no_linkedin_profile";
const NO_HOLDS = { usageId: null, reservationId: null };

/** A person known by an email address alone, enrolled; with `memberRef`, a member id stored too. */
async function addressOnly(slug: string, memberRef?: string) {
  const enrolled = await enrolledLead(slug, { email: `${slug}@nolink.example` });
  if (memberRef !== undefined) {
    const data = { providerRefs: { unipile: memberRef } };
    await app().person.update({ where: { id: enrolled.personId }, data });
  }
  return enrolled;
}
/** The reads reserved and committed on the account's days. */
const reads = async (accountId: string) => {
  const days = await app().senderQuotaUsage.findMany({ where: { senderAccountId: accountId } });
  return days.reduce((total, day) => total + day.readsReserved + day.readsCommitted, 0);
};
/** linkedin's slot of the claimed step, as the claim takes it. */
async function slotOf(accountId: string, stepId: string, actionType: "invite" | "message") {
  const { idempotencyKey } = await app().stepExecution.findUniqueOrThrow({ where: { id: stepId } });
  const slot = await run(() =>
    reserveSend({ accountId, actionType, idempotencyKey, withNote: false }),
  );
  assert.ok("reservationId" in slot, "the slot is reserved");
  return slot.reservationId;
}
const slotStatus = async (id: string) =>
  (await app().senderQuotaReservation.findUniqueOrThrow({ where: { id } })).status;
/** The person's steps as [key, status, error_code or skip_reason]. */
const statuses = async (personId: string) =>
  (await stepsOf(personId)).map(({ stepKey, status, errorCode, skipReason }) => [
    stepKey,
    status,
    errorCode ?? skipReason,
  ]);
/** The enrollment ended as a refused send ends it, the code its detail, and the lead finished. */
async function assertEnded(enrolled: { personId: string; enrollmentId: string }) {
  const { status, exitReason, exitDetail } = await enrollmentOf(enrolled.enrollmentId);
  assert.deepEqual([status, exitReason, exitDetail], ["exited", "send_refused", CODE]);
  assert.equal((await leadOf(enrolled.personId)).status, "finished");
}

test("a connection request of a person without a profile reserves no profile read: failed with no_linkedin_profile before the read, its enrollment exited", async () => {
  const { id: accountId } = await account();
  const enrolled = await addressOnly("no-profile-read");
  const { connect } = enrolled.steps;
  await moveStep(connect, "executing");
  const reserved = await run(() => reserveProfileRead(connect, NO_HOLDS, AT));
  assert.deepEqual(reserved, { blocked: CODE });
  assert.equal(await reads(accountId), 0, "no read reserved");
  assert.equal(await app().senderQuotaReservation.count(), 0, "no slot");
  assert.deepEqual(await statuses(enrolled.personId), [
    ["connect", "failed", CODE],
    ["message_1", "cancelled", CODE],
    ["follow_up_1", "cancelled", CODE],
    ["follow_up_2", "cancelled", CODE],
  ]);
  await assertEnded(enrolled);

  // The control: a person with a profile has the read reserved at their URL.
  const clear = await enrolledLead("with-profile-read");
  await moveStep(clear.steps.connect, "executing");
  const read = await run(() => reserveProfileRead(clear.steps.connect, NO_HOLDS, AT));
  assert.equal(
    "reservationId" in read && read.profileUrl,
    "https://linkedin.com/in/with-profile-read",
  );
  assert.equal(await reads(accountId), 1);
});

test("a connection request, a message or a withdrawal of a person without a profile writes no request, a member id stored or not: failed with no_linkedin_profile, its slot freed, its enrollment exited; a check builds none and keeps its holds", async () => {
  const { id: accountId } = await account();
  const cases = [
    { slug: "no-profile-invite", key: "connect", action: "invite" },
    { slug: "no-profile-message", key: "message_1", action: "message" },
  ] as const;
  for (const { slug, key, action } of cases) {
    const enrolled = await addressOnly(slug, `synthetic-ref-${slug}`);
    const id = enrolled.steps[key];
    await moveStep(id, "executing");
    const reservationId = await slotOf(accountId, id, action);
    const holds = { usageId: null, reservationId };
    // A check first, as the sender's recovery asks one: nothing built, nothing freed or moved.
    assert.deepEqual(await run(() => prepareRequest(id, holds, AT, true)), { unbuilt: CODE });
    assert.equal(await slotStatus(reservationId), "reserved", slug);
    assert.equal(
      (await app().stepExecution.findUniqueOrThrow({ where: { id } })).status,
      "executing",
    );
    assert.deepEqual(await run(() => prepareRequest(id, holds, AT)), { waiting: CODE }, slug);
    assert.equal(await slotStatus(reservationId), "released", slug);
    const [failed] = (await statuses(enrolled.personId)).filter(([stepKey]) => stepKey === key);
    assert.deepEqual(failed, [key, "failed", CODE], slug);
    await assertEnded(enrolled);
  }

  // A withdrawal, which holds no credits and no slot, the last step rewritten as one (queue.test.ts).
  const withdrawn = await addressOnly("no-profile-withdraw", "synthetic-ref-no-profile-withdraw");
  const withdrawal = withdrawn.steps.follow_up_2;
  const data = { actionType: "withdraw", stepKey: "withdraw" } as const;
  await app().stepExecution.update({ where: { id: withdrawal }, data });
  await moveStep(withdrawal, "executing");
  const check = await run(() => prepareRequest(withdrawal, NO_HOLDS, AT, true));
  assert.deepEqual(check, { unbuilt: CODE });
  assert.deepEqual(await run(() => prepareRequest(withdrawal, NO_HOLDS, AT)), { waiting: CODE });
  const steps = await statuses(withdrawn.personId);
  assert.deepEqual(
    steps.filter(([key]) => key === "withdraw"),
    [["withdraw", "failed", CODE]],
  );
  await assertEnded(withdrawn);

  // The control: a person with a profile and a member id has the approved request built.
  const clear = await enrolledLead("with-profile-invite");
  await app().person.update({
    where: { id: clear.personId },
    data: { providerRefs: { unipile: "synthetic-ref-with-profile" } },
  });
  const id = clear.steps.connect;
  await approved(id);
  await moveStep(id, "executing");
  const reservationId = await slotOf(accountId, id, "invite");
  const built = await run(() => prepareRequest(id, { usageId: null, reservationId }, AT, true));
  assert.ok("request" in built, "the control builds its request");
});
