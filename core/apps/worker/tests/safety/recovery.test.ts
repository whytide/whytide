// Safety cases of campaigns' recovery (beta-p4-040; core/modules/campaigns/README.md "Worker",
// docs/flows.md "The check first"), on the LinkedIn fake, the slice's Temporal and a schema of its
// database (fixtures/campaigns-sender.ts). The fake ignores the idempotency key, as Unipile does,
// so a second send shows as a second recorded call. A run terminated between the send and the
// settle sends once: the next run's check settles the step. A 5xx ends the run, and no call goes
// before linkedin's retry_at; an outage costs one check a quota day; a step the check found unsent
// is released, placed again and charged once, the plan starting its check and placing it again. A send activity is never retried by Temporal, a
// gate's pass grown stale is asked again, a step late at the gate goes back to the plan, measured
// from its slot after a profile read (fixtures/campaigns-member-reference.ts), and a step left
// `executing` counts in the account's gap.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  seedProfile,
  skipWait,
  storedRef,
  unknownLead,
} from "../fixtures/campaigns-member-reference.ts";
import {
  afterSend,
  app,
  contacts,
  DAY_MS,
  fake,
  MIN_ACTION_GAP_MS,
  now,
  OWNER,
  rowsOf,
  sender,
  senderStart,
  sends,
  skip,
  slotsOf,
  starts,
  stepOf,
  terminate,
  thenOnce,
  usagesOf,
  useGateFreshMs,
  useSenderTests,
  type Wrap,
} from "../fixtures/campaigns-sender.ts";

useSenderTests();
const GAP = MIN_ACTION_GAP_MS as number;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const OPT_OUT = { source: "manual", createdBy: OWNER };
/** The next quota day's start after THURSDAY, in UTC, the account's zone. */
const FRIDAY = "2026-10-23T00:00:00.000Z";
const calls = () => fake.recordedCalls.map(({ method }) => method);
const retryAtOf = async (accountId: string) =>
  (await app.senderAccount.findUniqueOrThrow({ where: { id: accountId } })).retryAt;
/** The send's answer returned once its run is terminated: a worker killed before the settle. */
const terminated: Wrap = (run) => async (input, context) => {
  const answer = await run(input, context);
  await terminate(context.workflowId);
  return answer;
};

test("a run terminated after the send activity returned and before the settle: the next run checks first and settles the step succeeded, one recorded call, one ok row, one charge", async () => {
  const s = await sender();
  const step = await s.ready("terminated");
  await assert.rejects(s.send({ linkedin_send_invite: terminated }));
  assert.equal(sends().length, 1);
  assert.equal((await stepOf(step.id)).status, "executing");

  const { result } = await s.send();
  assert.deepEqual(result, { sent: 1, blocked: 0, refused: 0, end: "no_step" });
  assert.equal(sends().length, 1);
  assert.deepEqual(
    (await rowsOf(step.id)).filter((row) => row.startsWith("invite:")),
    ["invite:ok"],
  );
  const row = await stepOf(step.id);
  assert.deepEqual([row.status, row.attempt, row.errorCode], ["succeeded", 1, null]);
  assert.deepEqual(await usagesOf(step.id), [":1 committed 1"]);
  assert.deepEqual(await slotsOf(step.id), ["committed"]);
  assert.equal(await s.hasRequest(step.id), false);
});

test("a 5xx ends the run with the step executing and its holds; no call before retry_at, the check refused until then; after it the check finds nothing sent: the credits released, and the step placed again is sent with one charge under a new key", async () => {
  const s = await sender();
  const step = await s.ready("outage");
  await s.ready("outage-next", "connect", "", afterSend());
  fake.failNext("linkedin_provider_error");
  const first = await s.send();
  assert.deepEqual(first.result, { sent: 0, blocked: 0, refused: 1, end: "unsettled" });
  let row = await stepOf(step.id);
  assert.deepEqual(
    [row.status, row.errorCode, row.dueAt],
    ["executing", "linkedin_provider_error", null],
  );
  assert.deepEqual(await usagesOf(step.id), [":1 reserved 1"]);
  const retryAt = await retryAtOf(s.accountId);
  assert.ok(retryAt && retryAt > now(), "linkedin's retry_at ahead");

  skip(10 * MINUTE_MS);
  const refused = await s.send();
  assert.deepEqual(refused.result, { sent: 0, blocked: 0, refused: 0, end: "unsettled" });
  assert.deepEqual(calls(), ["sendInvite"]);
  row = await stepOf(step.id);
  assert.deepEqual([row.status, row.dueAt?.getTime()], ["executing", retryAt.getTime()]);

  skip(retryAt.getTime() - now().getTime() + MINUTE_MS);
  const checked = await s.send();
  assert.deepEqual(checked.result, { sent: 0, blocked: 0, refused: 0, end: "no_step" });
  assert.deepEqual(calls(), ["sendInvite", "getRelation"]);
  row = await stepOf(step.id);
  assert.deepEqual(
    [row.status, row.scheduledFor, row.errorCode, row.attempt],
    ["scheduled", null, null, 1],
  );
  assert.deepEqual(await usagesOf(step.id), [":1 released 1"]);
  assert.deepEqual(await slotsOf(step.id), ["released"]);

  await s.place(step.id);
  assert.equal((await s.send()).result.sent, 1);
  row = await stepOf(step.id);
  assert.deepEqual([row.status, row.attempt], ["succeeded", 2]);
  assert.deepEqual(await usagesOf(step.id), [":1 released 1", ":2 committed 1"]);
  assert.deepEqual(await slotsOf(step.id), ["committed", "released"]);
  assert.equal(sends().length, 2);
});

test("after a 5xx the plan starts no sender before retry_at; after it the plan starts the check, which finds nothing sent, then places the step again on its own: sent with one charge under a new key", async () => {
  const s = await sender();
  const step = await s.ready("outage-plan");
  fake.failNext("linkedin_provider_error");
  assert.equal((await s.send()).result.end, "unsettled");
  assert.equal((await stepOf(step.id)).dueAt, null);
  const retryAt = await retryAtOf(s.accountId);
  assert.ok(retryAt && retryAt > now(), "linkedin's retry_at ahead");
  skip(10 * MINUTE_MS);
  assert.deepEqual(await s.plan(), { accounts: 1, placed: 0 });
  assert.deepEqual(starts, []);

  skip(retryAt.getTime() - now().getTime() + MINUTE_MS);
  assert.deepEqual(await s.plan(), { accounts: 1, placed: 0 });
  assert.deepEqual(starts, [senderStart(s.workspaceId, s.accountId)]);
  assert.deepEqual((await s.send()).result, { sent: 0, blocked: 0, refused: 0, end: "no_step" });
  const row = await stepOf(step.id);
  assert.deepEqual([row.status, row.errorCode, row.dueAt !== null], ["scheduled", null, true]);
  assert.deepEqual(await s.plan(), { accounts: 1, placed: 1 });
  assert.equal((await s.send()).result.sent, 1);
  assert.deepEqual(await usagesOf(step.id), [":1 released 1", ":2 committed 1"]);
  assert.equal(sends().length, 2);
});

test("during an outage a step gets one check a quota day: a check failing at the provider waits for the next quota day, whatever retry_at does", async () => {
  const s = await sender();
  const step = await s.ready("one-check");
  fake.failNext("linkedin_provider_error");
  await s.send();
  skip(HOUR_MS + MINUTE_MS);
  fake.failNext("linkedin_provider_error");
  assert.deepEqual((await s.send()).result, { sent: 0, blocked: 0, refused: 0, end: "unsettled" });
  assert.deepEqual(calls(), ["sendInvite", "getRelation"]);
  const row = await stepOf(step.id);
  assert.deepEqual([row.status, row.dueAt?.toISOString()], ["executing", FRIDAY]);

  // Past linkedin's pause, the same day: no check.
  skip(2 * HOUR_MS);
  assert.deepEqual((await s.send()).result, { sent: 0, blocked: 0, refused: 0, end: "no_step" });
  assert.deepEqual(calls(), ["sendInvite", "getRelation"]);

  // The next quota day: one check, which finds nothing sent.
  skip(DAY_MS);
  assert.deepEqual((await s.send()).result, { sent: 0, blocked: 0, refused: 0, end: "no_step" });
  assert.deepEqual(calls(), ["sendInvite", "getRelation", "getRelation"]);
  assert.equal((await stepOf(step.id)).status, "scheduled");
});

test("a send activity that fails before its call is not retried by Temporal: the run ends unsettled with no call, and the next run's check puts the step back", async () => {
  const s = await sender();
  const step = await s.ready("no-retry");
  const stopped: Wrap = (run) => (input, context) =>
    context.attempt === 1 ? Promise.reject(new Error("stopped")) : run(input, context);
  const { result } = await s.send({ linkedin_send_invite: stopped });
  assert.deepEqual(result, { sent: 0, blocked: 0, refused: 0, end: "unsettled" });
  assert.deepEqual(sends(), []);
  assert.equal((await stepOf(step.id)).status, "executing");

  assert.deepEqual((await s.send()).result, { sent: 0, blocked: 0, refused: 0, end: "no_step" });
  assert.deepEqual(sends(), []);
  const row = await stepOf(step.id);
  assert.deepEqual([row.status, row.scheduledFor, row.errorCode], ["scheduled", null, null]);
  assert.deepEqual(await usagesOf(step.id), [":1 released 1"]);
});

test("a gate's pass older than it holds when the call is scheduled is asked again: an opt-out after the first pass stops the call", async () => {
  const s = await sender();
  const step = await s.ready("stale-gate");
  const stale = thenOnce(async () => {
    await s.run(() => contacts.addOptOut(step.personId, OPT_OUT));
    await sleep(500);
  });
  useGateFreshMs(200);
  try {
    const { result } = await s.send({ campaigns_sender_gate: stale });
    assert.deepEqual(result, { sent: 0, blocked: 1, refused: 0, end: "no_step" });
  } finally {
    useGateFreshMs(undefined);
  }
  assert.deepEqual(sends(), []);
  const row = await stepOf(step.id);
  assert.deepEqual([row.status, row.skipReason], ["skipped", "opted_out"]);
  assert.deepEqual(await usagesOf(step.id), [":1 released 1"]);
  assert.deepEqual(await slotsOf(step.id), ["released"]);
});

test("a step more than a gap past its time at the gate before the call, after a stop since its claim, goes back to the plan: no call, its holds freed", async () => {
  const s = await sender();
  const step = await s.ready("late-gate");
  const stop = thenOnce(() => skip(GAP + 10_000));
  const { result } = await s.send({ campaigns_sender_prepare: stop });
  assert.deepEqual(result, { sent: 0, blocked: 1, refused: 0, end: "no_step" });
  assert.deepEqual(sends(), []);
  const row = await stepOf(step.id);
  assert.deepEqual(
    [row.status, row.scheduledFor, row.errorCode, row.attempt],
    ["scheduled", null, null, 1],
  );
  assert.deepEqual(await usagesOf(step.id), [":1 released 1"]);
  assert.deepEqual(await slotsOf(step.id), ["released"]);
  assert.equal(await s.hasRequest(step.id), false);
});

test("after a profile read the gate before the call measures from the slot, taken the read's wait after the step's time: a stop between the slot and the gate still puts it back, no call", async () => {
  const s = await sender();
  const step = await unknownLead(s, "late-after-read");
  seedProfile(step);
  const stop = thenOnce(() => skip(GAP + 10_000));
  const wraps = { campaigns_profile_settle: skipWait(), campaigns_sender_prepare: stop };
  assert.deepEqual((await s.send(wraps)).result, {
    sent: 0,
    blocked: 1,
    refused: 0,
    end: "no_step",
  });
  assert.deepEqual(sends(), []);
  const row = await stepOf(step.id);
  assert.deepEqual([row.status, row.scheduledFor, row.errorCode], ["scheduled", null, null]);
  assert.deepEqual(await usagesOf(step.id), [":1 released 1"]);
  assert.deepEqual(await slotsOf(step.id), ["released"]);
  assert.equal(await storedRef(step.personId), step.memberRef);
});

test("a step left executing after its gate's pass counts in the account's gap: the next step waits a gap after it", async () => {
  const s = await sender();
  const left = await s.ready("left-in-flight");
  await assert.rejects(s.send({ linkedin_send_invite: terminated }));
  // Its check not due before tomorrow, as after a failed one: only the gap holds the next step,
  // placed 10 s on, as a plan that counts sends only may place it (well within a gap of its time).
  await app.stepExecution.update({
    where: { id: left.id },
    data: { dueAt: new Date(now().getTime() + DAY_MS) },
  });
  const at = new Date(now().getTime() + 10_000);
  const next = await s.ready("after-in-flight", "connect", "", at);
  assert.deepEqual((await s.send()).result, { sent: 1, blocked: 0, refused: 0, end: "no_step" });
  const { jitChecks } = await stepOf(left.id);
  const gated = Date.parse((jitChecks as { at: string }).at);
  const sent = (await stepOf(next.id)).executedAt?.getTime() ?? 0;
  assert.ok(sent - gated >= GAP, `the next send ${sent - gated} ms after the step in flight`);
  assert.equal(sends().length, 2);
});
