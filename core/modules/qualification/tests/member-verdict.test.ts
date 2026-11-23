// A member's verdict (README "A member's verdict", lead-verdict-edit) on the worktree's database: set,
// changed and cleared on the lead's current snapshot, each time the snapshot and the lead decided
// again from the effective verdicts as fit-v1's computeFit and decide say, no model call, and
// qualification.lead_qualified published only when the status moved; the refusals; a criterion
// without a row; and the re-score, which carries the members' verdicts to the snapshot that takes
// the lead, a copy or one given back, and which an edit runs first when the criteria moved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLeadForPerson, upsertPersonFromSource } from "@whytide/contacts";
import { withTestDb } from "@whytide/db/testing";
import { readIcpForScoring } from "@whytide/icp";
import { assessPerson } from "../domain/assess/assess-person.ts";
import { clearMemberVerdict, setMemberVerdict } from "../domain/member-verdict.ts";
import { rescorePage } from "../domain/rescore.ts";
import { computeFit, decide } from "../domain/score/index.ts";
import { scoreSnapshot } from "../domain/score/score-snapshot.ts";
import type { Criterion, Verdict } from "../schemas/assess-fit.ts";
import { answer, contextOf, fake, run, seed } from "./fixtures/assess.ts";

withTestDb();
const WS = "wsp_qualification_member";
const OTHER = "wsp_qualification_member_b";
const EVENT = "qualification.lead_qualified";

/** The model's verdicts: location, a must, unknown, so the lead needs review. */
const MODEL: Record<Criterion, Verdict> = {
  title_function: "met",
  seniority: "met",
  company_size: "met",
  industry: "met",
  location: "unknown",
  must_haves: "met",
};

/** A scored lead of the person on the fake's answer of MODEL's verdicts. */
async function scoredLead(workspaceId: string): Promise<{ personId: string; snapshotId: string }> {
  const personId = await seed(workspaceId);
  await run(workspaceId, () =>
    createLeadForPerson({ personId, source: { kind: "imported", ref: "imp_1" } }),
  );
  const verdicts = answer().verdicts.map((verdict) => ({
    ...verdict,
    verdict: MODEL[verdict.criterion],
    // The evidence block's words ground must_haves, which the fixture's answer leaves unknown.
    evidence: MODEL[verdict.criterion] === "unknown" ? "" : verdict.evidence || "Runs RevOps",
  }));
  fake.reset();
  fake.script(answer({ verdicts }));
  const assessed = await assessPerson(
    { personId, icpVersion: 1, evidence: ["RevOps"] },
    contextOf(workspaceId),
  );
  if (assessed.status !== "assessed") throw new Error(assessed.status);
  await run(workspaceId, () => scoreSnapshot(assessed.snapshotId));
  return { personId, snapshotId: assessed.snapshotId };
}

/** What fit-v1 decides for these effective verdicts with the workspace's criteria now. */
async function expected(verdicts: Record<Criterion, Verdict>) {
  const { criteria } = await run(WS, () => readIcpForScoring(WS));
  const list = Object.entries(verdicts).map(([criterion, verdict]) => ({
    criterion: criterion as Criterion,
    verdict,
  }));
  const { fit, confidence } = computeFit(list, criteria);
  const { status } = decide({ fit, confidence, disqualifiers: [], verdicts: list, criteria });
  return { status, fitScore: fit };
}

const lead = (personId: string) =>
  run(WS, async (tx) => {
    const row = await tx.lead.findFirstOrThrow({ where: { personId } });
    const { qualificationStatus: status, fitScore, currentScoreSnapshotId, why } = row;
    return { status, fitScore, snapshotId: currentScoreSnapshotId, why };
  });
const events = () => run(WS, (tx) => tx.outboxEntry.count({ where: { eventName: EVENT } }));
const set = (personId: string, criterion: string, verdict: string, note?: string) =>
  run(WS, () =>
    setMemberVerdict(personId, criterion, { verdict: verdict as Verdict, note }, new Date()),
  );
const clear = (personId: string, criterion: string) =>
  run(WS, () => clearMemberVerdict(personId, criterion));
const weigh = (weight: number) =>
  run(WS, (tx) => tx.criterion.updateMany({ where: { key: "must_haves" }, data: { weight } }));
/** The snapshot's rows of the criterion: the model's verdict and the member's. */
const rowOf = (snapshotId: string, criterion: Criterion) =>
  run(WS, (tx) =>
    tx.criterionVerdict.findFirst({
      where: { snapshotId, criterion },
      select: { verdict: true, memberVerdict: true, memberNote: true },
    }),
  );

test("a member's verdict is set, changed and cleared: the lead is decided again from the effective verdicts each time, the event only when its status moves, no model call", async () => {
  const { personId, snapshotId } = await scoredLead(WS);
  const calls = fake.recordedCalls.length;
  const before = await expected(MODEL);
  assert.equal(before.status, "needs_review");
  assert.deepEqual((await lead(personId)).status, before.status);
  const base = await events();

  // The last unknown set: the lead leaves needs_review.
  const read = await set(personId, "location", "met", "  Lives in Berlin  ");
  const location = read.verdicts.find((verdict) => verdict.criterion === "location");
  assert.deepEqual(
    { ...location, member: location?.member && { ...location.member, setAt: undefined } },
    {
      criterion: "location",
      verdict: "met",
      modelVerdict: "unknown",
      evidence: "",
      weight: 10,
      points: 1,
      member: {
        verdict: "met",
        note: "Lives in Berlin",
        setBy: "service:qualification_test",
        setAt: undefined,
        mine: true,
      },
    },
  );
  const met = await expected({ ...MODEL, location: "met" });
  assert.notEqual(met.status, "needs_review");
  assert.deepEqual([read.status, read.fitScore], [met.status, met.fitScore]);
  const decided = await lead(personId);
  assert.deepEqual([decided.status, decided.fitScore], [met.status, met.fitScore]);
  assert.equal(decided.snapshotId, snapshotId);
  assert.equal(await events(), base + 1);

  // Changed, the status stays: no event.
  const partly = await expected({ ...MODEL, location: "partially_met" });
  assert.equal(partly.status, met.status);
  await set(personId, "location", "partially_met");
  assert.deepEqual((await lead(personId)).fitScore, partly.fitScore);
  assert.deepEqual(await rowOf(snapshotId, "location"), {
    verdict: "unknown",
    memberVerdict: "partially_met",
    memberNote: null,
  });
  assert.equal(await events(), base + 1);

  // A must set not_met: whatever decide says for it, here not qualified; the why names the member.
  const missed = await expected({ ...MODEL, location: "partially_met", title_function: "not_met" });
  assert.equal(missed.status, "not_qualified");
  await set(personId, "title_function", "not_met");
  const stopped = await lead(personId);
  assert.deepEqual([stopped.status, stopped.fitScore], [missed.status, missed.fitScore]);
  assert.deepEqual((stopped.why as { key: string }[])[0], {
    key: "qualification.why.must_missed_member",
    params: { criterion: "title_function" },
  });
  assert.equal(await events(), base + 2);

  // Cleared one by one: the model's verdicts count again, back to needs_review.
  await clear(personId, "title_function");
  assert.equal((await lead(personId)).status, partly.status);
  await clear(personId, "location");
  const back = await lead(personId);
  assert.deepEqual([back.status, back.fitScore], [before.status, before.fitScore]);
  assert.deepEqual(await rowOf(snapshotId, "location"), {
    verdict: "unknown",
    memberVerdict: null,
    memberNote: null,
  });
  assert.equal(await events(), base + 4);
  // Nothing left to clear: nothing decided, nothing published.
  await clear(personId, "location");
  assert.equal(await events(), base + 4);
  assert.equal(fake.recordedCalls.length, calls);
});

test("refused: a criterion outside the ICP's, a verdict outside the four, a long note, a lead never scored, another workspace's lead", async () => {
  const { personId } = await scoredLead(WS);
  const theirs = await scoredLead(OTHER);
  const pending = await run(WS, async () => {
    const { person } = await upsertPersonFromSource({
      source: "import",
      provider: "csv",
      profile: { linkedinUrl: "https://linkedin.com/in/never-scored" },
    });
    await createLeadForPerson({ personId: person.id, source: { kind: "imported", ref: "imp_1" } });
    return person.id;
  });
  const invalid = (fields: string[]) => ({
    code: "qualification_input_invalid",
    details: { fields },
  });
  await assert.rejects(set(personId, "budget", "met"), invalid(["criterion"]));
  await assert.rejects(set(personId, "location", "maybe"), invalid(["verdict"]));
  await assert.rejects(set(personId, "location", "met", "x".repeat(501)), invalid(["note"]));
  await assert.rejects(clear(personId, "budget"), invalid(["criterion"]));
  await assert.rejects(set(pending, "location", "met"), { code: "score_snapshot_not_found" });
  await assert.rejects(set(theirs.personId, "location", "met"), { code: "lead_not_found" });
  await assert.rejects(clear(theirs.personId, "location"), { code: "lead_not_found" });
  const untouched = await run(OTHER, (tx) =>
    tx.criterionVerdict.count({ where: { memberVerdict: { not: null } } }),
  );
  assert.equal(untouched, 0);
});

test("a criterion without a row on the snapshot gets one holding the member's verdict alone, gone when cleared", async () => {
  const { personId, snapshotId } = await scoredLead(WS);
  await run(WS, (tx) =>
    tx.criterionVerdict.deleteMany({ where: { snapshotId, criterion: "location" } }),
  );
  const none = await clear(personId, "location");
  assert.deepEqual(
    none.verdicts.find((verdict) => verdict.criterion === "location"),
    {
      criterion: "location",
      verdict: null,
      modelVerdict: null,
      evidence: "",
      weight: null,
      points: null,
      member: null,
    },
  );
  const read = await set(personId, "location", "met");
  const added = read.verdicts.find((verdict) => verdict.criterion === "location");
  assert.deepEqual(
    [added?.verdict, added?.modelVerdict, added?.member?.verdict],
    ["met", null, "met"],
  );
  assert.deepEqual(await rowOf(snapshotId, "location"), {
    verdict: null,
    memberVerdict: "met",
    memberNote: null,
  });
  const met = await expected({ ...MODEL, location: "met" });
  assert.equal((await lead(personId)).status, met.status);
  await clear(personId, "location");
  assert.equal(await rowOf(snapshotId, "location"), null);
});

test("the re-score keeps the members' verdicts: a copy carries them, a snapshot given back takes them, and an edit after a criteria change re-scores first", async () => {
  const { personId, snapshotId } = await scoredLead(WS);
  await set(personId, "location", "met", "Berlin office");

  // must_haves weighs 60: a copy takes the lead, the member's verdict on it.
  await weigh(60);
  assert.deepEqual(await run(WS, () => rescorePage({ personIds: [personId] })), {
    rescored: 1,
    skipped: 0,
    next: null,
  });
  const copied = await lead(personId);
  assert.notEqual(copied.snapshotId, snapshotId);
  const copy = copied.snapshotId ?? "";
  assert.deepEqual(await rowOf(copy, "location"), {
    verdict: "unknown",
    memberVerdict: "met",
    memberNote: "Berlin office",
  });
  const withCopy = await expected({ ...MODEL, location: "met" });
  assert.deepEqual([copied.status, copied.fitScore], [withCopy.status, withCopy.fitScore]);

  // An edit on the copy, then the criteria back: the assessment's own snapshot takes the lead
  // again, with the members' verdicts of now.
  await set(personId, "seniority", "not_met");
  await weigh(20);
  await run(WS, () => rescorePage({ personIds: [personId] }));
  const given = await lead(personId);
  assert.equal(given.snapshotId, snapshotId);
  assert.deepEqual(await rowOf(snapshotId, "seniority"), {
    verdict: "met",
    memberVerdict: "not_met",
    memberNote: null,
  });
  const both = await expected({ ...MODEL, location: "met", seniority: "not_met" });
  assert.deepEqual([given.status, given.fitScore], [both.status, both.fitScore]);

  // The criteria move again and the lead is edited before any re-score: it moves to the copy first.
  await weigh(60);
  await clear(personId, "seniority");
  const moved = await lead(personId);
  assert.equal(moved.snapshotId, copy);
  assert.deepEqual(await rowOf(copy, "seniority"), {
    verdict: "met",
    memberVerdict: null,
    memberNote: null,
  });
  const after = await expected({ ...MODEL, location: "met" });
  assert.deepEqual([moved.status, moved.fitScore], [after.status, after.fitScore]);
});
