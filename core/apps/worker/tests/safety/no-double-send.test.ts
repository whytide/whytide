// No double send on a retry (beta-p1-050; core/modules/linkedin docs/flows.md "The send activities"),
// on the fakes, the slice's database and its Temporal. The fake ignores the idempotency key, as
// Unipile does, so a second send shows as a second recorded call. A send that went out and whose
// settle was lost is found by the check before the step's retry, before a retry under a new
// reservation once the first was swept past its hold, and before the activity's own Temporal retry
// after the worker died; a key counted already, late included, is never sent again. Each case ends
// with one send recorded and one `ok` row for the step. An attempt too late for its call makes none.
import assert from "node:assert/strict";
import { test } from "node:test";
import { retries } from "../../src/retry.ts";
import {
  db,
  later,
  methods,
  reservationOf,
  rowsOf,
  type Sender,
  sender,
  sends,
  settle,
  type Tenant,
  useSendTests,
  useTemporal,
  type Wrap,
} from "../fixtures/linkedin-send.ts";

useSendTests();
const temporal = useTemporal();
const HOUR_MS = 3_600_000;
const SECOND_MS = 1000;
/** SEND_CALL_MARGIN_MS less SEND_CALL_MIN_LEFT_MS (linkedin's workflows/constants.ts): the call's cutoff. */
const CUTOFF_MS = 2 * 60_000 - 45_000;
const ACTIVITY = { invite: "linkedin_send_invite", message: "linkedin_send_message" } as const;
const ROWS = { invite: "invite:ok", message: "message:ok" } as const;

for (const actionType of ["invite", "message"] as const) {
  test(`${actionType === "invite" ? "an" : "a"} ${actionType} that went out, its settle lost: the step's retry checks first, makes no second call and counts it once; a repeat after is no call either`, async () => {
    const account = await sender();
    const step = await account.step(actionType);
    const name = ACTIVITY[actionType];
    await assert.rejects(account.call(name, step.input(), 1, account.killedAfterSend()), /killed/);
    assert.equal((await reservationOf(step.reservationId)).status, "reserved");

    const sent = { sent: true, stepExecutionId: step.stepExecutionId };
    assert.deepEqual(await account.call(name, step.input(2)), sent);
    assert.equal(sends().length, 1);
    assert.equal((await reservationOf(step.reservationId)).status, "committed");
    assert.deepEqual(await rowsOf(step.stepExecutionId), [
      ROWS[actionType],
      "send_check:ok",
      "send_check:reserved",
    ]);

    assert.deepEqual(await account.call(name, step.input()), sent, "a repeat at attempt 1");
    assert.equal(sends().length, 1);
    assert.equal(
      (await rowsOf(step.stepExecutionId)).filter((row) => row.endsWith(":ok")).length,
      2,
    );
  });
}

test("an invite that went out, its reservation swept past the hold, then the step's retry under a new one: one call, one ok row, counted once on the day", async () => {
  const account = await sender();
  const step = await account.step("invite");
  const killed = account.killedAfterSend();
  await assert.rejects(account.call("linkedin_send_invite", step.input(), 1, killed), /killed/);
  later(3 * HOUR_MS);
  const again = await account.reserve(step.idempotencyKey, "invite");
  assert.notEqual(again, step.reservationId);

  const answer = await account.call("linkedin_send_invite", step.input(2, again));
  assert.deepEqual(answer, { sent: true, stepExecutionId: step.stepExecutionId });
  assert.equal(sends().length, 1);
  const statuses = await Promise.all([step.reservationId, again].map(reservationOf));
  assert.deepEqual(
    statuses.map(({ status }) => status),
    ["expired", "committed"],
  );
  const day = await db().senderQuotaUsage.findFirstOrThrow({
    where: { senderAccountId: account.accountId },
  });
  assert.deepEqual([day.invitesReserved, day.invitesCommitted], [0, 1]);
  assert.deepEqual(await rowsOf(step.stepExecutionId), [
    "invite:ok",
    "send_check:ok",
    "send_check:reserved",
  ]);
});

test("a worker killed after the call and before the settle: the activity's Temporal retry runs the check and makes no second call; the history names the failure by its code", async () => {
  const account = await sender();
  const step = await account.step("invite");
  const killFirst: Wrap = (run) => (input, context) =>
    run(input, context.attempt > 1 ? context : { ...context, tenant: account.killedAfterSend() });
  const calls = [{ activity: "linkedin_send_invite", input: step.input() }];
  const { workflowId, answers } = await temporal.probe(calls, { linkedin_send_invite: killFirst });

  assert.deepEqual(answers, [{ sent: true, stepExecutionId: step.stepExecutionId }]);
  assert.deepEqual(methods(), ["sendInvite", "getRelation"]);
  assert.equal((await reservationOf(step.reservationId)).status, "committed");
  assert.deepEqual(await rowsOf(step.stepExecutionId), [
    "invite:ok",
    "send_check:ok",
    "send_check:reserved",
  ]);
  const history = await temporal.historyOf(workflowId);
  assert.match(history, /"message":"activity_failed"/);
  assert.doesNotMatch(history, /"message":"killed"/);
});

test("an attempt past its cutoff by its own clock, as a slow check or provider makes one while Temporal may start the next: no call, the slot held, send_attempt_late, retried; the next attempt checks first and sends once; a second before the cutoff sends", async (t) => {
  // The monotonic clock the activity reads, moved on at an attempt's first run.
  const real = performance.now.bind(performance);
  let moved = 0;
  t.mock.method(performance, "now", () => real() + moved);
  const slowBy = (account: Sender, ms: number): Tenant => {
    let first = true;
    return (fn) => {
      if (first) moved += ms;
      first = false;
      return account.run(fn);
    };
  };
  const account = await sender();
  const late = await account.step("message");
  const inTime = await account.step("message");
  const sentAs = ({ stepExecutionId }: { stepExecutionId: string }) => ({
    sent: true,
    stepExecutionId,
  });

  const slow = slowBy(account, CUTOFF_MS + SECOND_MS);
  await assert.rejects(account.call("linkedin_send_message", late.input(), 1, slow), {
    code: "send_attempt_late",
  });
  assert.equal(retries({ kind: "provider" }, "send_attempt_late", 1), true);
  assert.deepEqual([sends(), methods()], [[], []]);
  assert.equal((await reservationOf(late.reservationId)).status, "reserved");
  assert.deepEqual(await rowsOf(late.stepExecutionId), []);
  assert.deepEqual(await account.call("linkedin_send_message", late.input(), 2), sentAs(late));
  assert.deepEqual(methods(), ["listRecentMessages", "sendMessage"]);

  const almost = slowBy(account, CUTOFF_MS - SECOND_MS);
  const answer = await account.call("linkedin_send_message", inTime.input(), 1, almost);
  assert.deepEqual(answer, sentAs(inTime));
  assert.equal(sends().length, 2);
});

test("a key counted already, late, while a live reservation holds it: no call, the live one released, the step answered as sent", async () => {
  const account = await sender();
  const step = await account.step("invite");
  later(3 * HOUR_MS);
  const live = await account.reserve(step.idempotencyKey, "invite");
  await account.run(() => settle.commitSend(step.reservationId));
  assert.equal((await reservationOf(step.reservationId)).status, "committed_late");

  const answer = await account.call("linkedin_send_invite", step.input(1, live));
  assert.deepEqual(answer, { sent: true, stepExecutionId: step.stepExecutionId });
  assert.equal(sends().length, 0);
  assert.equal((await reservationOf(live)).status, "released");
  assert.deepEqual(await rowsOf(step.stepExecutionId), ["invite:ok"]);
});
