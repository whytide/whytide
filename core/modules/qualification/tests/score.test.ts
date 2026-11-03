// scoreSnapshot end to end on the worktree's database (docs/flows.md "The score"): from a snapshot
// that assessPerson stored on the LLM fake to the lead row, in one tenant run as the batch's activity
// runs it. A failure leaves the snapshot and the lead as they were; a newer snapshot takes the lead
// and the older one stays; a late run never moves the lead back; a scored snapshot answers what it
// stored; a stale ICP version is refused.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLeadForPerson } from "@whytide/contacts";
import { withTestDb } from "@whytide/db/testing";
import { assessPerson } from "../domain/assess/assess-person.ts";
import { scoreSnapshot } from "../domain/score/score-snapshot.ts";
import type { AssessFitOutput } from "../schemas/assess-fit.ts";
import { answer, contextOf, fake, run, seed } from "./fixtures/assess.ts";

withTestDb();
const WS = "wsp_qualification_score";

/** A snapshot of the person on the fake's answer; each excerpt is a new call, so a new snapshot. */
async function assessed(personId: string, excerpt: string, change: Partial<AssessFitOutput> = {}) {
  fake.reset();
  fake.script(answer(change));
  const result = await assessPerson(
    { personId, icpVersion: 1, evidence: [excerpt] },
    contextOf(WS),
  );
  if (result.status !== "assessed") throw new Error(`assessPerson: ${result.status}`);
  return result.snapshotId;
}
const score = (snapshotId: string) => run(WS, () => scoreSnapshot(snapshotId));
const lead = (personId: string) =>
  run(WS, (tx) => tx.lead.findFirstOrThrow({ where: { personId } }));
const leadFor = (personId: string) =>
  run(WS, () => createLeadForPerson({ personId, source: { kind: "imported", ref: "imp_1" } }));
/** The snapshot's scores, and each verdict's weight and points. */
const scores = (id: string) =>
  run(WS, async (tx) => {
    const snapshot = await tx.scoreSnapshot.findFirstOrThrow({ where: { id } });
    const rows = await tx.criterionVerdict.findMany({ where: { snapshotId: id } });
    const { status, fitScore, confidence, tier, scorerVersion } = snapshot;
    const points = (value: unknown) => (value === null ? null : Number(value));
    const parts = rows.map((row) => [row.criterion, [row.weight, points(row.points)]]);
    return { status, fitScore, confidence, tier, scorerVersion, parts: Object.fromEntries(parts) };
  });

test("scoreSnapshot scores the snapshot and gives the lead its decision in one run; a failure changes neither", async () => {
  const personId = await seed(WS);
  const first = await assessed(personId, "Runs RevOps for the region");
  const unscored = await scores(first);
  assert.deepEqual(
    [unscored.status, unscored.fitScore, unscored.parts.must_haves],
    ["assessed", null, [null, null]],
  );

  // No lead yet: contacts refuses after the snapshot's update, and the run takes it back.
  await assert.rejects(score(first), { code: "lead_not_found" });
  assert.deepEqual(await scores(first), unscored);
  await run(WS, (tx) => tx.icp.updateMany({ data: { version: 2 } }));
  await assert.rejects(score(first), { code: "icp_version_stale" });
  await run(WS, (tx) => tx.icp.updateMany({ data: { version: 1 } }));
  await assert.rejects(score("ssn_none"), { code: "score_snapshot_not_found" });

  await leadFor(personId);
  const decided = { status: "qualified", fitScore: 88, confidence: "high", tier: "hot" } as const;
  assert.deepEqual(await score(first), { snapshotId: first, personId, ...decided, reason: null });
  assert.deepEqual(await scores(first), {
    ...decided,
    scorerVersion: "fit-v1",
    parts: {
      title_function: [30, 1],
      seniority: [15, 1],
      company_size: [10, 1],
      industry: [15, 1],
      location: [10, 1],
      must_haves: [20, 0.4],
    },
  });
  const row = await lead(personId);
  assert.deepEqual(
    {
      status: row.qualificationStatus,
      fitScore: row.fitScore,
      confidence: row.fitConfidence,
      tier: row.tier,
      snapshot: row.currentScoreSnapshotId,
      icpVersion: row.icpVersionScored,
      reason: row.statusReason,
      why: row.why,
    },
    {
      ...decided,
      snapshot: first,
      icpVersion: 1,
      reason: null,
      why: [
        {
          key: "qualification.why.fit",
          params: {
            criterion: "title_function",
            quote: "Head of Revenue Operations",
            met: 5,
            total: 6,
          },
        },
        { key: "qualification.why.gap", params: { criterion: "must_haves", more: 0 } },
      ],
    },
  );
});

test("a newer snapshot takes the lead and the older stays; a late or a repeated run moves nothing", async () => {
  const personId = await seed(WS);
  await leadFor(personId);
  const first = await assessed(personId, "Runs RevOps for the region");
  const firstResult = await score(first);
  const late = await assessed(personId, "Recruits for clients", { disqualifiers: ["recruiter"] });
  const crm = { criterion: "must_haves", verdict: "met", evidence: "sales team on a CRM" } as const;
  const verdicts = [...answer().verdicts.slice(0, 5), crm];
  const newest = await assessed(personId, "Runs a sales team on a CRM", { verdicts });

  const result = await score(newest);
  const decided = { status: "qualified", fitScore: 100, confidence: "high", tier: "hot" } as const;
  assert.deepEqual(result, { snapshotId: newest, personId, ...decided, reason: null });
  const current = await lead(personId);
  assert.deepEqual([current.currentScoreSnapshotId, current.fitScore], [newest, 100]);
  assert.deepEqual(current.why, [
    {
      key: "qualification.why.fit",
      params: {
        criterion: "title_function",
        quote: "Head of Revenue Operations",
        met: 6,
        total: 6,
      },
    },
  ]);
  assert.equal((await scores(first)).fitScore, 88);

  // Older than the lead's snapshot: scored, and the lead stays where it is.
  const blocked = {
    status: "not_qualified",
    fitScore: 88,
    confidence: "high",
    tier: "hot",
  } as const;
  assert.deepEqual(await score(late), {
    snapshotId: late,
    personId,
    ...blocked,
    reason: "recruiter",
  });
  assert.deepEqual(await lead(personId), current);
  // Scored already, as a retried activity finds it: the stored result, nothing written.
  assert.deepEqual(await score(first), firstResult);
  assert.deepEqual(await score(newest), result);
  assert.deepEqual(await lead(personId), current);
  assert.equal((await run(WS, (tx) => tx.scoreSnapshot.findMany())).length, 3);
});

test("two concurrent runs on one snapshot score it once: both answer its result and the lead takes it", async () => {
  const personId = await seed(WS);
  await leadFor(personId);
  const id = await assessed(personId, "Runs RevOps for two regions");
  const [one, two] = await Promise.all([score(id), score(id)]);
  assert.deepEqual(one, two);
  assert.deepEqual([one.status, one.fitScore], ["qualified", 88]);
  assert.equal((await lead(personId)).currentScoreSnapshotId, id);
  assert.equal((await scores(id)).status, "qualified");
});
