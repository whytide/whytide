// test:tenancy for qualification's four tables (docs/rules/security.md §3; core/packages/db README
// "Register a tenant table in the isolation test"): assessPerson writes a snapshot and its verdicts
// in each workspace, the batch's attempt and the person's intent a row of their own (no id: the
// person names it), each read in its own workspace only; erasePerson, scoreSnapshot, getSnapshot,
// countQualified, the golden set's lines, the batch's retired decisions (title-check-ai), the
// intent's update and leadPriorities go through the tenant client of the caller's run.
import test from "node:test";
import { assertScoped, isolationTest, withTestDb } from "@whytide/db/testing";
import { assessPerson, erasePerson } from "../domain/assess/assess-person.ts";
import { goldenLines } from "../domain/export/golden-set.ts";
import { leadPriorities, setLeadPriority } from "../domain/intent/store.ts";
import { retiredDecisions } from "../domain/reassess/index.ts";
import { countQualified } from "../domain/score/count-qualified.ts";
import { getSnapshot } from "../domain/score/get-snapshot.ts";
import { scoreSnapshot, updateIntent } from "../domain/score/score-snapshot.ts";
import { useSignalReader } from "../domain/signal-reader.ts";
import { answer, contextOf, fake, run, seed } from "./fixtures/assess.ts";

withTestDb();

/** The fixture person assessed in the workspace: the snapshot's id. */
async function assessed(workspaceId: string): Promise<string> {
  const personId = await seed(workspaceId);
  fake.reset();
  fake.script(answer());
  const result = await assessPerson({ personId, icpVersion: 1 }, contextOf(workspaceId));
  if (result.status !== "assessed") throw new Error(`assessPerson: ${result.status}`);
  return result.snapshotId;
}

isolationTest("score_snapshots", {
  createRow: async (workspaceId) => ({ id: await assessed(workspaceId) }),
  readAs: (workspaceId) => run(workspaceId, (tx) => tx.scoreSnapshot.findMany()),
});

isolationTest("criterion_verdicts", {
  async createRow(workspaceId) {
    const snapshotId = await assessed(workspaceId);
    const where = { snapshotId, criterion: "title_function" as const };
    return run(workspaceId, (tx) => tx.criterionVerdict.findFirstOrThrow({ where }));
  },
  readAs: (workspaceId) => run(workspaceId, (tx) => tx.criterionVerdict.findMany()),
});

isolationTest("assessment_attempts", {
  async createRow(workspaceId) {
    const personId = `per_${workspaceId}`;
    const row = { workspaceId, personId, icpId: `icp_${workspaceId}`, icpVersion: 1, attempt: 2 };
    await run(workspaceId, (tx) => tx.assessmentAttempt.create({ data: row }));
    return { id: row.personId };
  },
  async readAs(workspaceId) {
    const rows = await run(workspaceId, (tx) => tx.assessmentAttempt.findMany());
    return rows.map((row) => ({ id: row.personId }));
  },
});

isolationTest("intent_scores", {
  async createRow(workspaceId) {
    const personId = `per_${workspaceId}`;
    await run(workspaceId, () => setLeadPriority(personId, 60));
    return { id: personId };
  },
  async readAs(workspaceId) {
    const rows = await run(workspaceId, (tx) => tx.intentScore.findMany());
    return rows.map((row) => ({ id: row.personId }));
  },
});

test("erasePerson, scoreSnapshot, getSnapshot, countQualified, goldenLines and retiredDecisions go through the tenant client of the caller's run", async () => {
  await assertScoped(() => erasePerson("per_0"));
  await assertScoped(() => scoreSnapshot("ssn_0"));
  await assertScoped(() => getSnapshot("per_0"));
  await assertScoped(() => countQualified({ from: new Date(0), to: new Date() }));
  await assertScoped(() => retiredDecisions(1));
  const decision = { decision: "good_lead", reasonCode: null, reasonText: null } as const;
  const review = { ...decision, goodReasonText: "Fits", personId: "per_0", snapshotId: "ssn_0" };
  await assertScoped(() => goldenLines([{ ...review, decidedAt: new Date() }]));
});

test("updateIntent, with a reader, and leadPriorities go through the tenant client of the caller's run", async () => {
  const restore = useSignalReader({ intentInputs: async () => [], excerpts: async () => [] });
  try {
    await assertScoped(() => updateIntent("per_0"));
  } finally {
    restore();
  }
  await assertScoped(() => leadPriorities(["per_0"]));
  await assertScoped(() => setLeadPriority("per_0", 50));
});
