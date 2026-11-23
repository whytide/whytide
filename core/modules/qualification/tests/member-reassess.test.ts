// A member's new assessment (README "A new assessment", lead-rescore-ai) on the worktree's database:
// the rounds of attempts; the press, which puts a decided lead back to pending with
// member_requested, its snapshot kept and its attempt moved to the next round, and publishes
// qualification.reassess_requested, whose subscriber starts the batch; a pending lead, which it
// leaves as it is; and the readers of a waiting lead's kept snapshot, the lead page's read, a
// member's verdict and the criteria re-score, which leave it to the batch. The batch end to end:
// core/apps/worker/tests/qualification-reassess.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLeadForPerson } from "@whytide/contacts";
import { withTestDb } from "@whytide/db/testing";
import {
  bindWorkflowStarter,
  isAppError,
  servicePrincipal,
  subscribersOf,
  type WorkflowStart,
  withTenantContext,
} from "@whytide/platform";
import { assessPerson } from "../domain/assess/assess-person.ts";
import { requestReassess } from "../domain/member-reassess/index.ts";
import { nextRound, roundSpent } from "../domain/member-reassess/rounds.ts";
import { setMemberVerdict } from "../domain/member-verdict.ts";
import { requestRescore } from "../domain/rescore.ts";
import { getSnapshot } from "../domain/score/get-snapshot.ts";
import { scoreSnapshot } from "../domain/score/score-snapshot.ts";
import { batchStart } from "../events.ts";
import { answer, contextOf, fake, run, seed } from "./fixtures/assess.ts";

withTestDb();
const WS = "wsp_qualification_reassess";
const EVENT = "qualification.reassess_requested";

/** A lead of the fixture person, scored on the fake's answer. */
async function scoredLead(): Promise<{ personId: string; snapshotId: string }> {
  const personId = await seed(WS);
  await run(WS, () =>
    createLeadForPerson({ personId, source: { kind: "imported", ref: "imp_1" } }),
  );
  fake.reset();
  fake.script(answer());
  const assessed = await assessPerson({ personId, icpVersion: 1 }, contextOf(WS));
  if (assessed.status !== "assessed") throw new Error(assessed.status);
  await run(WS, () => scoreSnapshot(assessed.snapshotId));
  return { personId, snapshotId: assessed.snapshotId };
}

const press = (personId: string) => run(WS, () => requestReassess(personId));
const lead = (personId: string) =>
  run(WS, (tx) =>
    tx.lead.findFirstOrThrow({
      where: { personId },
      select: { qualificationStatus: true, statusReason: true, currentScoreSnapshotId: true },
    }),
  );
const attemptOf = (personId: string) =>
  run(WS, async (tx) => {
    const row = await tx.assessmentAttempt.findFirst({ where: { personId, icpVersion: 1 } });
    return row?.attempt ?? null;
  });
const pressed = () =>
  run(WS, (tx) =>
    tx.outboxEntry.findMany({ where: { eventName: EVENT }, select: { payload: true } }),
  );
/** The code an AppError rejects with. */
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (isAppError(error) ? error.code : "thrown"),
  );

test("the rounds: attempts 1 to 3, 4 to 6 and so on; a press moves to the next round's first; the provider failing a round's last ends it", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(nextRound), [4, 4, 4, 7, 7, 7, 10]);
  // roundSpent reads the attempt after the one released: 4 after the third.
  assert.deepEqual([2, 3, 4, 5, 6, 7, 10].map(roundSpent), [
    false,
    false,
    true,
    false,
    false,
    true,
    true,
  ]);
});

test("a press puts a scored lead back to pending, member_requested, its snapshot kept, its attempt at the next round, and publishes the event; a lead that waits stays as it is", async () => {
  const { personId, snapshotId } = await scoredLead();
  assert.notEqual((await lead(personId)).qualificationStatus, "pending");
  assert.equal(await attemptOf(personId), null);

  assert.deepEqual(await press(personId), { status: "pending", requested: true });
  assert.deepEqual(await lead(personId), {
    qualificationStatus: "pending",
    statusReason: "member_requested",
    currentScoreSnapshotId: snapshotId,
  });
  assert.equal(await attemptOf(personId), 4);
  assert.deepEqual(await pressed(), [{ payload: { workspaceId: WS, personId } }]);

  // Waiting already: nothing moves, no second event.
  assert.deepEqual(await press(personId), { status: "pending", requested: false });
  assert.equal(await attemptOf(personId), 4);
  assert.equal((await pressed()).length, 1);

  assert.equal(await codeOf(press("per_missing")), "lead_not_found");
  assert.equal(await codeOf(press("")), "qualification_input_invalid");
});

test("a waiting lead's kept snapshot is the batch's: the lead page reads none, a member's verdict is refused, the criteria re-score marks it not", async () => {
  const { personId } = await scoredLead();
  // Other criteria than those that scored it: the re-score would move the lead.
  await run(WS, (tx) =>
    tx.criterion.updateMany({ where: { key: "must_haves" }, data: { weight: 5 } }),
  );
  assert.equal((await run(WS, () => requestRescore({ personIds: [personId] }))).marked, 1);
  await press(personId);

  assert.equal(await codeOf(run(WS, () => getSnapshot(personId))), "score_snapshot_not_found");
  const verdict = run(WS, () => setMemberVerdict(personId, "location", { verdict: "met" }));
  assert.equal(await codeOf(verdict), "score_snapshot_not_found");
  assert.equal((await run(WS, () => requestRescore({ personIds: [personId] }))).marked, 0);
  assert.equal((await run(WS, () => requestRescore({}))).marked, 0);
});

test("qualification.reassess_requested starts qualification_batch of the delivered workspace, one at a time", async () => {
  const starts: WorkflowStart[] = [];
  const unbind = bindWorkflowStarter({
    start: async (request) => {
      starts.push(request);
      return { started: true };
    },
  });
  const payload = { workspaceId: "wsp_other", personId: "per_1" };
  const context = { id: "obx_m", name: EVENT, workspaceId: WS, createdAt: new Date(), attempt: 1 };
  try {
    await withTenantContext({ workspaceId: WS, principal: servicePrincipal("test") }, async () => {
      for (const handler of subscribersOf(EVENT)) await handler(payload, { ...context, tx: {} });
    });
  } finally {
    unbind();
  }
  assert.deepEqual(starts, [batchStart(WS)]);
});
