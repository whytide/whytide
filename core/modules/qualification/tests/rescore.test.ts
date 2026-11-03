// The re-score (README "The re-score") on the worktree's database: from a scored snapshot's stored
// verdicts with the current criteria, a copy keyed with their hash takes the lead, with no model call;
// the criteria that scored it skip it, the assessment's own snapshot included; criteria scored before
// give their snapshot back. The request, by the route's
// command or by `pnpm rescore`, is an outbox event whose subscriber starts the worker's run, which
// core/apps/worker/tests/qualification-batch.test.ts runs end to end.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLeadForPerson } from "@whytide/contacts";
import { asRole, withTestDb } from "@whytide/db/testing";
import {
  bindWorkflowStarter,
  servicePrincipal,
  subscribersOf,
  type WorkflowStart,
  withTenantContext,
} from "@whytide/platform";
import { runRescore } from "../cli/rescore.ts";
import { assessPerson } from "../domain/assess/assess-person.ts";
import { useClient } from "../domain/client.ts";
import { requestRescore, rescorePage } from "../domain/rescore.ts";
import { criteriaHash } from "../domain/score/criteria-hash.ts";
import { scoreSnapshot } from "../domain/score/score-snapshot.ts";
import { rescoreStart } from "../events.ts";
import { answer, contextOf, fake, run, seed } from "./fixtures/assess.ts";

withTestDb();
const WS = "wsp_qualification_rescore";

test("criteriaHash: the criteria's key, weight, must and enabled, in any order", () => {
  const criteria = [
    { key: "seniority", weight: 15, isMust: false, enabled: true },
    { key: "location", weight: 10, isMust: true, enabled: true },
  ] as const;
  const hash = criteriaHash(criteria);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(criteriaHash([...criteria].reverse()), hash);
  for (const change of [{ weight: 16 }, { isMust: true }, { enabled: false }]) {
    assert.notEqual(criteriaHash([{ ...criteria[0], ...change }, criteria[1]]), hash);
  }
});

test("a re-score with the criteria that scored the lead writes nothing; other criteria score a copy from the stored verdicts that takes the lead; earlier criteria give their snapshot back", async () => {
  const personId = await seed(WS);
  await run(WS, () =>
    createLeadForPerson({ personId, source: { kind: "imported", ref: "imp_1" } }),
  );
  fake.reset();
  fake.script(answer());
  const assessed = await assessPerson(
    { personId, icpVersion: 1, evidence: ["RevOps"] },
    contextOf(WS),
  );
  if (assessed.status !== "assessed") throw new Error(assessed.status);
  await run(WS, () => scoreSnapshot(assessed.snapshotId));
  const calls = fake.recordedCalls.length;
  const page = (personIds?: string[]) => run(WS, () => rescorePage({ personIds }));
  const lead = () => run(WS, (tx) => tx.lead.findFirstOrThrow({ where: { personId } }));
  const weigh = (weight: number) =>
    run(WS, (tx) => tx.criterion.updateMany({ where: { key: "must_haves" }, data: { weight } }));
  /** What the route answers: the leads the request marks, every lead's or the named persons'. */
  const marked = async (personIds?: string[]) =>
    (await run(WS, () => requestRescore({ personIds }))).marked;

  // The assessment's own snapshot keeps the hash of the criteria that scored it: no copy.
  assert.deepEqual([await marked(), await marked([personId])], [0, 0]);
  assert.deepEqual(await page(), { rescored: 0, skipped: 1, next: null });
  const first = await lead();
  assert.deepEqual(
    [first.currentScoreSnapshotId, first.fitScore, first.tier],
    [assessed.snapshotId, 88, "hot"],
  );

  // must_haves, unknown, weighs 60: (800 + 240) / 140 is 74, warm.
  await weigh(60);
  assert.deepEqual([await marked(), await marked([personId, "per_none"])], [1, 1]);
  assert.deepEqual(await page([personId, "per_none"]), { rescored: 1, skipped: 1, next: null });
  assert.deepEqual([(await lead()).fitScore, (await lead()).tier], [74, "warm"]);

  // Back to 20: the assessment's own snapshot takes the lead again, nothing new written.
  await weigh(20);
  assert.deepEqual(await page(), { rescored: 1, skipped: 0, next: null });
  const back = await lead();
  assert.deepEqual(
    [back.currentScoreSnapshotId, back.fitScore, back.tier],
    [first.currentScoreSnapshotId, 88, "hot"],
  );
  const stored = await run(WS, (tx) =>
    tx.scoreSnapshot.findMany({ orderBy: { createdAt: "asc" } }),
  );
  const fits = stored.map((row) => [row.fitScore, row.criteriaHash === ""]);
  assert.deepEqual(fits, [
    [88, true],
    [74, false],
  ]);
  assert.equal(fake.recordedCalls.length, calls);
});

test("pnpm rescore writes qualification.rescore_requested, whose subscriber starts the request's qualification_rescore", async () => {
  useClient(asRole("app"));
  const lines: string[] = [];
  const print = (line: string) => lines.push(line);
  assert.equal(await runRescore(["--workspace", WS, "--person", "per_1"], print), 0);
  assert.equal(await runRescore(["--person", "per_1"], print), 2);
  assert.match(
    lines[0] ?? "",
    /^rescore_requested: rsq_\w+ for per_1 in wsp_qualification_rescore$/,
  );
  assert.match(lines[1] ?? "", /^usage: pnpm rescore/);
  const where = { eventName: "qualification.rescore_requested" };
  const [entry, ...more] = await run(WS, (tx) => tx.outboxEntry.findMany({ where }));
  assert.equal(more.length, 0);
  const payload = entry?.payload as { requestId: string; personIds: string[] };
  assert.deepEqual(payload, {
    workspaceId: WS,
    requestId: payload.requestId,
    personIds: ["per_1"],
  });

  const starts: WorkflowStart[] = [];
  const unbind = bindWorkflowStarter({
    start: async (request) => {
      starts.push(request);
      return { started: true };
    },
  });
  const name = where.eventName;
  const context = { id: "obx_r", name, workspaceId: WS, createdAt: new Date(), attempt: 1, tx: {} };
  try {
    await withTenantContext({ workspaceId: WS, principal: servicePrincipal("test") }, async () => {
      for (const handler of subscribersOf(name)) await handler(payload, context);
    });
  } finally {
    unbind();
  }
  assert.deepEqual(starts, [rescoreStart(WS, payload.requestId, ["per_1"])]);
  assert.equal(starts[0]?.workflowId, `qualification.rescore:${WS}:${payload.requestId}`);
});
