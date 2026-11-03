// Safety cases of the profile read before a connection request (beta-p4-030; core/modules/campaigns
// README.md "Worker", docs/flows.md "The read before an invite"), on the LinkedIn fake, the slice's
// Temporal and a schema of its database (fixtures/campaigns-sender.ts,
// fixtures/campaigns-member-reference.ts), with the wait after the read as the module computes it,
// skipped on the clocks: the read reserved first, under the step, and logged, counted in the day's
// reads and in the 200; the invite's call no sooner than MIN_MINUTES_AFTER_PROFILE_READ after the
// read; an empty balance reads nothing; a refused read, then an invite, charges one send; a person
// suppressed, or replying, during the wait is not invited.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  callsOf,
  MIN_MINUTES_AFTER_PROFILE_READ,
  MINUTE_MS,
  readCounts,
  readRows,
  seedProfile,
  skipWait,
  storedRef,
  unknownLead,
} from "../fixtures/campaigns-member-reference.ts";
import {
  app,
  contacts,
  linkedin,
  now,
  OWNER,
  sender,
  sends,
  slotsOf,
  stepOf,
  usagesOf,
  useSenderTests,
} from "../fixtures/campaigns-sender.ts";

useSenderTests();
const WAIT_MS = (MIN_MINUTES_AFTER_PROFILE_READ as number) * MINUTE_MS;
const OPT_OUT = { source: "manual", createdBy: OWNER };

test("a person with no member ref: the read is reserved under the step before its one call, logged and counted in the day's reads and the 200; the invite's call comes no sooner than 3 minutes after it, in the wait the module computes", async () => {
  const s = await sender();
  const step = await unknownLead(s, "safe-read", "Noor, I read your post on pipeline reviews");
  seedProfile(step);
  const waits: number[] = [];
  const { result } = await s.send({ campaigns_profile_settle: skipWait(waits) });

  assert.deepEqual(result, { sent: 1, blocked: 0, refused: 0, end: "no_step" });
  assert.deepEqual(waits, [WAIT_MS]);
  assert.equal(callsOf("getProfile").length, 1);
  assert.deepEqual(
    sends().map(({ method }) => method),
    ["sendInvite"],
  );
  const [reserved, made, ...more] = await readRows(s.accountId);
  assert.deepEqual(more, []);
  assert.deepEqual([reserved?.outcome, reserved?.objectRef], ["reserved", step.id]);
  assert.deepEqual([made?.outcome, made?.objectRef], ["ok", null]);
  assert.ok(reserved && made && reserved.at <= made.at, "the call before its reservation");
  const reads = await app.senderQuotaReservation.findMany({
    where: { senderAccountId: s.accountId, actionType: "read" },
  });
  assert.deepEqual(
    reads.map(({ status, count, committed }) => [status, count, committed]),
    [["committed", 1, 1]],
  );
  // The read and the invite, each one of the 200.
  assert.deepEqual(await readCounts(s.accountId), { reserved: 0, committed: 1, actions: 2 });
  const { executedAt } = await stepOf(step.id);
  const gap = (executedAt?.getTime() ?? 0) - (made?.at.getTime() ?? 0);
  assert.ok(gap >= WAIT_MS, `invited ${gap} ms after the read`);
  assert.equal(await storedRef(step.personId), step.memberRef);
});

test("with an empty balance nothing is read: no call, no read reserved, no slot; the step waits insufficient_credits", async () => {
  const s = await sender(0);
  const step = await unknownLead(s, "safe-broke");
  seedProfile(step);
  const { result } = await s.send();

  assert.deepEqual(result, { sent: 0, blocked: 0, refused: 1, end: "refused" });
  assert.deepEqual(callsOf("getProfile"), []);
  assert.deepEqual(sends(), []);
  assert.deepEqual(await readRows(s.accountId), []);
  const row = await stepOf(step.id);
  assert.deepEqual(
    [row.status, row.errorCode, row.scheduledFor, row.attempt],
    ["scheduled", "insufficient_credits", null, 0],
  );
  assert.deepEqual(await usagesOf(step.id), []);
  assert.deepEqual(await slotsOf(step.id), []);
});

test("a read refused before its call, then the invite: the first key released, the second committed, one send charged", async () => {
  const s = await sender();
  const step = await unknownLead(s, "safe-refused");
  seedProfile(step);
  const account = { where: { id: s.accountId } };
  const retryAt = new Date(now().getTime() + 10 * MINUTE_MS);
  await app.senderAccount.update({ ...account, data: { retryAt } });
  assert.deepEqual((await s.send()).result, { sent: 0, blocked: 0, refused: 1, end: "refused" });
  const waiting = await stepOf(step.id);
  assert.deepEqual(
    [waiting.status, waiting.errorCode, waiting.scheduledFor, waiting.dueAt?.getTime()],
    ["scheduled", "rate_limited", null, retryAt.getTime()],
  );
  assert.deepEqual(callsOf("getProfile"), []);
  assert.deepEqual(await usagesOf(step.id), [":1 released 1"]);

  await app.senderAccount.update({ ...account, data: { retryAt: null } });
  await s.place(step.id);
  const { result } = await s.send({ campaigns_profile_settle: skipWait() });
  assert.deepEqual(result, { sent: 1, blocked: 0, refused: 0, end: "no_step" });
  assert.equal(callsOf("getProfile").length, 1);
  assert.equal(sends().length, 1);
  assert.deepEqual(await usagesOf(step.id), [":1 released 1", ":2 committed 1"]);
  assert.deepEqual(await slotsOf(step.id), ["committed"]);
});

test("a person suppressed, or replying, during the wait is not invited: the gate after the wait blocks, the credits freed, no slot taken", async () => {
  const s = await sender();
  const optedOut = await unknownLead(s, "wait-opt-out");
  seedProfile(optedOut);
  const optOut = () => s.run(() => contacts.addOptOut(optedOut.personId, OPT_OUT));
  const first = await s.send({ campaigns_profile_settle: skipWait([], optOut) });
  assert.deepEqual(first.result, { sent: 0, blocked: 1, refused: 0, end: "no_step" });

  const replied = await unknownLead(s, "wait-reply");
  seedProfile(replied);
  const reply = async () => {
    const row = { senderAccountId: s.accountId, personId: replied.personId };
    const { id } = await linkedin.createOutreach(s.workspaceId, row);
    await app.senderOutreach.update({ where: { id }, data: { lastInboundAt: now() } });
  };
  const second = await s.send({ campaigns_profile_settle: skipWait([], reply) });
  assert.deepEqual(second.result, { sent: 0, blocked: 1, refused: 0, end: "no_step" });

  assert.equal(callsOf("getProfile").length, 2);
  assert.deepEqual(sends(), []);
  const [out, held] = await Promise.all([stepOf(optedOut.id), stepOf(replied.id)]);
  assert.deepEqual([out.status, out.skipReason], ["skipped", "opted_out"]);
  assert.deepEqual([held.status, held.skipReason], ["held", "replied"]);
  for (const id of [optedOut.id, replied.id]) {
    assert.deepEqual(await usagesOf(id), [":1 released 1"]);
    assert.deepEqual(await slotsOf(id), []);
  }
});
