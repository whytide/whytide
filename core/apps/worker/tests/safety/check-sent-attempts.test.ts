// Safety case of the check's cap (gamma-p0-085; core/modules/linkedin/README.md "Worker",
// core/modules/campaigns/README.md "Worker"), on the LinkedIn fake, the slice's Temporal and a
// schema of its database (fixtures/campaigns-sender.ts). linkedin_check_sent has
// CHECK_SENT_ATTEMPTS, 3, and each attempt reserves a send_check read. A check that fails on every
// attempt after the provider answered, as when the worker loses its database there, runs three
// times, reserves three reads and ends the sender run unsettled, with nothing sent though another
// step is ready; the next run checks before any send, settles the step sent, then sends the other.
// The fake ignores the idempotency key, as Unipile does, so a second send would show as a second
// recorded call.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  afterSend,
  fake,
  rowsOf,
  type Sender,
  sender,
  sends,
  stepOf,
  type Tenant,
  terminate,
  usagesOf,
  useSenderTests,
  type Wrap,
} from "../fixtures/campaigns-sender.ts";

useSenderTests();
const calls = () => fake.recordedCalls.map(({ method }) => method);
const relations = () => calls().filter((method) => method === "getRelation").length;
/** The send's answer returned once its run is terminated: a worker killed before the settle. */
const terminated: Wrap = (run) => async (input, context) => {
  const answer = await run(input, context);
  await terminate(context.workflowId);
  return answer;
};
/** Every attempt fails once the fake has answered its relation read: no attempt settles. */
function failingAfterRead(attempts: number[]): Wrap {
  return (run) => (input, context) => {
    attempts.push(context.attempt);
    const before = relations();
    const tenant: Tenant = (fn) =>
      relations() > before ? Promise.reject(new Error("database lost")) : context.tenant(fn);
    return run(input, { ...context, tenant });
  };
}
/** A step sent by a run terminated before its settle: left `executing`, due for its check. */
async function leftExecuting(s: Sender, slug: string) {
  const step = await s.ready(slug);
  await assert.rejects(s.send({ linkedin_send_invite: terminated }));
  assert.equal((await stepOf(step.id)).status, "executing");
  return step;
}

test("a check failing on every attempt runs three times and reserves three send_check reads; the run ends unsettled and sends nothing; the next run checks before any send", async () => {
  const s = await sender();
  const step = await leftExecuting(s, "check-cap");
  const other = await s.ready("check-cap-other", "connect", "", afterSend());

  const attempts: number[] = [];
  const { result } = await s.send({ linkedin_check_sent: failingAfterRead(attempts) });
  assert.deepEqual(result, { sent: 0, blocked: 0, refused: 0, end: "unsettled" });
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(calls(), ["sendInvite", "getRelation", "getRelation", "getRelation"]);
  const checks = (await rowsOf(step.id)).filter((row) => row.startsWith("send_check:"));
  assert.deepEqual(checks, Array(3).fill("send_check:reserved"));
  assert.equal((await stepOf(step.id)).status, "executing");
  assert.deepEqual(await usagesOf(step.id), [":1 reserved 1"]);
  const waiting = await stepOf(other.id);
  assert.deepEqual([waiting.status, waiting.creditUsageId], ["scheduled", null]);

  const next = await s.send();
  assert.deepEqual(next.result, { sent: 2, blocked: 0, refused: 0, end: "no_step" });
  assert.deepEqual(calls().slice(4), ["getRelation", "sendInvite"]);
  assert.equal(sends().length, 2);
  const settled = await stepOf(step.id);
  assert.deepEqual([settled.status, settled.attempt], ["succeeded", 1]);
  assert.deepEqual(await usagesOf(step.id), [":1 committed 1"]);
  assert.equal((await stepOf(other.id)).status, "succeeded");
});
