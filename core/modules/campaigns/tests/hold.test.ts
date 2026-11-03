// The hold on reply (beta-p2-050; README.md "The hold on reply"), on a schema of the worktree's
// database, in a tenant run as `app` standing for inbox's store: every pending step of the person
// held, in every enrollment, the sent and the claimed steps left, each active enrollment replied and
// the lead replied with one change; a second call changing nothing; the caller's failure rolling the
// hold back; a suppressed lead kept suppressed; no id refused before any write; a reply racing an
// approval's delivery waiting on the lead's lock and holding the enrollment it makes; and a skip racing
// a reply waiting on the lead's lock too, then finding the step held, with no deadlock (beta-p5-010).
import assert from "node:assert/strict";
import test from "node:test";
import { addOptOut, lockLeadStatus, recordLeadStatus } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { newId } from "@whytide/platform";
import { enrollApproved } from "../domain/enroll/enroll.ts";
import { holdForReply } from "../domain/hold.ts";
import { SKIPPED_STEP_FIELDS, type Skip, skipStep } from "../domain/steps/skip.ts";
import { APPROVER, fixture } from "./fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
const { app, run, account, enrolledLead, moveStep, stepsOf, enrollmentOf, leadOf } =
  fixture("wsp_campaigns_hold");
const hold = (personId: string, at = new Date()) => run(() => holdForReply(personId, { at }));
const rowsOf = async (personId: string) =>
  (await stepsOf(personId)).map(({ stepKey, status, skipReason }) => [stepKey, status, skipReason]);

/** Resolves once a transaction waits on the backend `pid`'s locks; five seconds at most. */
async function blockedBy(pid: number): Promise<void> {
  for (let waited = 0; ; waited += 1) {
    const [blocked] = await asRole("owner").$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
    if ((blocked?.n ?? 0) > 0) return;
    assert.ok(waited < 200, `nothing waited on backend ${pid}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A promise and its resolver, to hold a transaction open until a test releases it. */
function gate<T = void>(): { promise: Promise<T>; open: (value: T) => void } {
  let open: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

test("every pending step of the person is held, in every enrollment; sent and claimed steps stay; each active enrollment and the lead become replied", async () => {
  await account();
  const first = await enrolledLead("hold-every");
  const { personId } = first;
  // The first enrollment ended with steps still pending, as no task leaves one yet: the hold
  // covers every enrollment of the person all the same.
  await moveStep(first.steps.connect, "succeeded");
  const exited = { status: "exited", exitReason: "removed", endedAt: new Date() } as const;
  await app().enrollment.update({ where: { id: first.enrollmentId }, data: exited });
  const secondId = await run(async (tx) => {
    await recordLeadStatus(personId, "approved", { actor: { type: "user", id: APPROVER } });
    const approval = { sourceEventId: newId("obx"), personId, approvedBy: APPROVER };
    assert.equal(await enrollApproved(tx, approval), "enrolled");
    const { id } = await tx.enrollment.findFirstOrThrow({ where: { personId, status: "active" } });
    return id;
  });
  const second = (await stepsOf(personId)).filter(
    ({ id }) => !Object.values(first.steps).includes(id),
  );
  const [connect, message1, followUp1] = second;
  assert.ok(connect && message1 && followUp1);
  // The sent connect holds its key: the second enrollment's claimed step is its first message.
  await moveStep(connect.id, "scheduled");
  await moveStep(message1.id, "executing");
  await moveStep(followUp1.id, "awaiting_approval");
  const other = await enrolledLead("hold-other");

  const at = new Date();
  const held = await hold(personId, at);
  assert.equal(held.length, 6, "three pending steps of each enrollment");
  assert.deepEqual(await rowsOf(personId), [
    ["connect", "succeeded", null],
    ["message_1", "held", "replied"],
    ["follow_up_1", "held", "replied"],
    ["follow_up_2", "held", "replied"],
    ["connect", "held", "replied"],
    ["message_1", "executing", null],
    ["follow_up_1", "held", "replied"],
    ["follow_up_2", "held", "replied"],
  ]);
  assert.deepEqual(await enrollmentOf(secondId), {
    ...{ status: "replied", exitReason: null, exitDetail: null, endedAt: at },
  });
  assert.equal((await enrollmentOf(first.enrollmentId)).status, "exited");
  const lead = await leadOf(personId);
  assert.equal(lead.status, "replied");
  assert.equal(lead.changes.at(-1), "in_campaign>replied");
  const system = await app().leadStatusChange.findFirstOrThrow({
    where: { personId, toStatus: "replied" },
  });
  assert.deepEqual([system.actorType, system.actorId], ["system", null]);
  // Nobody else's steps.
  assert.ok((await stepsOf(other.personId)).every(({ status }) => status === "planned"));
});

test("a second call changes nothing and records no second status change", async () => {
  await account();
  const { personId, enrollmentId, steps } = await enrolledLead("hold-twice");
  await moveStep(steps.connect, "scheduled");
  assert.equal((await hold(personId)).length, 4);
  const before = {
    steps: await stepsOf(personId),
    enrollment: await enrollmentOf(enrollmentId),
    lead: await leadOf(personId),
  };
  assert.deepEqual(await hold(personId), []);
  assert.deepEqual(
    {
      steps: await stepsOf(personId),
      enrollment: await enrollmentOf(enrollmentId),
      lead: await leadOf(personId),
    },
    before,
  );
  assert.equal(before.lead.changes.filter((change) => change.endsWith(">replied")).length, 1);
});

test("the caller's transaction failing after the hold leaves no step held and the enrollment active", async () => {
  await account();
  const { personId, enrollmentId, steps } = await enrolledLead("hold-rollback");
  await moveStep(steps.connect, "scheduled");
  const before = await rowsOf(personId);
  const failure = new Error("the caller failed after the hold");
  await assert.rejects(
    run(async () => {
      assert.equal((await holdForReply(personId, { at: new Date() })).length, 4);
      throw failure;
    }),
    failure,
  );
  assert.deepEqual(await rowsOf(personId), before);
  assert.equal((await enrollmentOf(enrollmentId)).status, "active");
  assert.equal((await leadOf(personId)).status, "in_campaign");
});

test("a suppressed lead stays suppressed: the steps are held and the reply records no status", async () => {
  await account();
  const { personId, enrollmentId } = await enrolledLead("hold-suppressed");
  await run(() => addOptOut(personId, { source: "system", reason: "reply_opt_out" }));
  assert.equal((await hold(personId)).length, 4);
  assert.equal((await enrollmentOf(enrollmentId)).status, "replied");
  const lead = await leadOf(personId);
  assert.equal(lead.status, "suppressed");
  assert.ok(!lead.changes.some((change) => change.endsWith(">replied")));
});

test("no id is person_not_found, and no instant an error, before any write", async () => {
  await account();
  const { personId } = await enrolledLead("hold-no-id");
  const before = await rowsOf(personId);
  for (const id of ["", " ", undefined]) {
    await assert.rejects(hold(id as string), { code: "person_not_found" });
  }
  await assert.rejects(hold(personId, new Date(Number.NaN)), /at: no instant/);
  assert.deepEqual(await rowsOf(personId), before);
});

test("a reply racing an approval's delivery waits on the lead's lock and holds the new enrollment", async () => {
  await account();
  const { personId, enrollmentId } = await enrolledLead("hold-race");
  // The first enrollment ended, its steps cancelled, and the lead approved again: the delivery
  // enrolls the person again.
  const exited = { status: "exited", exitReason: "removed", endedAt: new Date() } as const;
  await app().enrollment.update({ where: { id: enrollmentId }, data: exited });
  await app().stepExecution.updateMany({ where: { enrollmentId }, data: { status: "cancelled" } });
  await run(() =>
    recordLeadStatus(personId, "approved", { actor: { type: "user", id: APPROVER } }),
  );
  const approval = { sourceEventId: newId("obx"), personId, approvedBy: APPROVER };
  const locked = gate<number>();
  const released = gate();
  // The delivery's transaction holds the lead's lock, its enrollment written, until released.
  const delivery = run(async (tx) => {
    const outcome = await enrollApproved(tx, approval);
    const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    locked.open(row?.pid ?? 0);
    await released.promise;
    return outcome;
  });
  const pid = await locked.promise;
  const holding = hold(personId);
  // Released once the hold waits on the delivery's transaction.
  await blockedBy(pid);
  released.open();

  assert.equal(await delivery, "enrolled");
  assert.equal((await holding).length, 4, "the new enrollment's steps");
  const second = (await stepsOf(personId)).filter(({ status }) => status === "held");
  assert.equal(second.length, 4);
  const active = await app().enrollment.count({ where: { personId, status: "active" } });
  assert.equal(active, 0);
  assert.equal((await leadOf(personId)).status, "replied");
});

test("a skip racing a reply's hold waits on the lead's lock, then finds the step held: no deadlock", async () => {
  await account();
  const { personId, enrollmentId, steps } = await enrolledLead("hold-skip");
  await moveStep(steps.connect, "awaiting_approval");
  const found = await app().stepExecution.findUniqueOrThrow({
    where: { id: steps.connect },
    select: SKIPPED_STEP_FIELDS,
  });
  const step = { ...found, status: "awaiting_approval" as const };
  const skip: Skip = {
    reason: "skipped_by_owner",
    at: new Date(),
    actor: { type: "user", id: APPROVER },
  };
  const locked = gate<number>();
  const released = gate();
  // The reply's transaction takes the lead's lock, as the hold does first, then holds once released:
  // a skip that locked the enrollment before the lead would hold what the hold waits for.
  const replying = run(async (tx) => {
    await lockLeadStatus(personId);
    const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    locked.open(row?.pid ?? 0);
    await released.promise;
    return holdForReply(personId, { at: new Date() });
  });
  const pid = await locked.promise;
  const skipping = run((tx) => skipStep(tx, step, skip));
  await blockedBy(pid);
  released.open();

  assert.equal((await replying).length, 4, "every pending step held, the connection request too");
  assert.equal(await skipping, false, "the hold came first: the skip found the step held");
  assert.deepEqual((await rowsOf(personId))[0], ["connect", "held", "replied"]);
  assert.equal((await enrollmentOf(enrollmentId)).status, "replied");
  assert.equal((await leadOf(personId)).status, "replied");
});
