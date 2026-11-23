// The re-score (README "The re-score") on the worktree's database: from a scored snapshot's stored
// verdicts with the current criteria, a copy keyed with their hash takes the lead, with no model call;
// the criteria that scored it skip it, the assessment's own snapshot included; criteria scored before
// give their snapshot back. The request, by the route's
// command or by `pnpm rescore`, is an outbox event whose subscriber starts the worker's run, which
// core/apps/worker/tests/qualification-batch.test.ts runs end to end. With a signal reader, every
// named person gets the intent of now, with no event; a decision and an intent update at once wait
// for each other on the person's lock. Each lead is re-scored with its own snapshot's audience's
// criteria (gamma-p5-050).
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
import { PERSON_LOCK } from "../domain/intent/constants.ts";
import { requestRescore, rescorePage } from "../domain/rescore.ts";
import { criteriaHash } from "../domain/score/criteria-hash.ts";
import { scoreSnapshot, updateIntent } from "../domain/score/score-snapshot.ts";
import { type IntentInput, type SignalReader, useSignalReader } from "../domain/signal-reader.ts";
import { rescoreStart } from "../events.ts";
import { addAudience, answer, contextOf, fake, run, seed, seedPerson } from "./fixtures/assess.ts";

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

test("each lead is re-scored with its own audience's criteria: a change of one audience's moves its leads only", async () => {
  const fallbackLead = await seed(WS);
  const founders = await addAudience(WS, "Founders");
  const foundersLead = await seedPerson(WS, "founders-lead");
  fake.reset();
  fake.script(answer(), answer());
  for (const [personId, icpId] of [
    [fallbackLead, undefined],
    [foundersLead, founders],
  ] as const) {
    await run(WS, () =>
      createLeadForPerson({ personId, source: { kind: "imported", ref: "imp_1" } }),
    );
    const input = { personId, icpId, icpVersion: 1, evidence: ["RevOps"] };
    const assessed = await assessPerson(input, contextOf(WS));
    if (assessed.status !== "assessed") throw new Error(assessed.status);
    await run(WS, () => scoreSnapshot(assessed.snapshotId));
  }
  const scored = (personId: string) =>
    run(WS, async (tx) => {
      const lead = await tx.lead.findFirstOrThrow({ where: { personId } });
      const where = { id: lead.currentScoreSnapshotId ?? "" };
      const snapshot = await tx.scoreSnapshot.findFirstOrThrow({ where });
      return [lead.fitScore, lead.tier, lead.icpIdScored, snapshot.icpId];
    });
  assert.deepEqual(await scored(foundersLead), [88, "hot", founders, founders]);

  // Founders' must_haves, unknown, weighs 60: (800 + 240) / 140 is 74, warm; the default's stay.
  const where = { icpId: founders, key: "must_haves" };
  await run(WS, (tx) => tx.criterion.updateMany({ where, data: { weight: 60 } }));
  assert.equal((await run(WS, () => requestRescore({}))).marked, 1);
  assert.deepEqual(await run(WS, () => rescorePage({})), { rescored: 1, skipped: 1, next: null });
  assert.deepEqual(await scored(foundersLead), [74, "warm", founders, founders]);
  const fallback = await run(WS, (tx) => tx.icp.findFirstOrThrow({ where: { isDefault: true } }));
  assert.deepEqual(await scored(fallbackLead), [88, "hot", fallback.id, fallback.id]);
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

const T0 = new Date("2026-11-02T10:00:00.000Z");
const HOUR = 3_600_000;
const after = (hours: number) => new Date(T0.getTime() + hours * HOUR);
/** One of the person's signals, rated 1 and `other`. */
const signal = (personId: string, eventId: string, kind: IntentInput["kind"], at = T0) => ({
  ...{ personId, eventId, sourceId: "src_1", kind, role: "comment" as const, relevance: 1 },
  ...{ intentClass: "other" as const, occurredAt: at, ownerUserId: null, count: 1 },
});

/**
 * A fake reader of `items`; hold() keeps its next call waiting: `inside` once that call is in,
 * `release` lets it go on.
 */
function readerOf(items: IntentInput[]) {
  let held: { enter: () => void; wait: Promise<void> } | undefined;
  const reader: SignalReader = {
    async intentInputs({ personIds }) {
      const hold = held;
      held = undefined;
      if (hold) {
        hold.enter();
        await hold.wait;
      }
      return items.filter((item) => personIds.includes(item.personId));
    },
    excerpts: async () => [],
  };
  const hold = () => {
    const inside = Promise.withResolvers<void>();
    const go = Promise.withResolvers<void>();
    held = { enter: inside.resolve, wait: go.promise };
    return { inside: inside.promise, release: go.resolve };
  };
  return { reader, hold };
}

/** The fixture person's lead, assessed and decided at T0 with `reader` in place. */
async function decided(reader: SignalReader) {
  const personId = await seed(WS);
  await run(WS, () =>
    createLeadForPerson({ personId, source: { kind: "imported", ref: "imp_1" } }),
  );
  fake.reset();
  fake.script(answer());
  const assessed = await assessPerson({ personId, icpVersion: 1 }, contextOf(WS));
  if (assessed.status !== "assessed") throw new Error(assessed.status);
  const restore = useSignalReader(reader);
  await run(WS, () => scoreSnapshot(assessed.snapshotId, T0));
  return { personId, snapshotId: assessed.snapshotId, restore };
}
const leadOf = (personId: string) =>
  run(WS, (tx) => tx.lead.findFirstOrThrow({ where: { personId } }));
const rowOf = (personId: string) =>
  run(WS, (tx) => tx.intentScore.findFirstOrThrow({ where: { personId } }));
const keysOf = (why: unknown) => (why as { key: string }[]).map(({ key }) => key.slice(18));
const decisions = () =>
  run(WS, (tx) => tx.outboxEntry.count({ where: { eventName: "qualification.lead_qualified" } }));
/** Until a run waits for the person's lock, within five seconds. */
async function waitingOnLock(personId: string) {
  const key = `${PERSON_LOCK}:${WS}:${personId}`;
  for (const deadline = Date.now() + 5_000; Date.now() < deadline; ) {
    const [row] = await asRole("app").$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
        AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${key}, 0)`;
    if ((row?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("no run waited for the person's lock");
}

test("with a reader, a decision writes the intent row and the lead's tier is the priority's; the re-score gives every named person the intent of now, a new signal at once, with no status change and no event", async () => {
  const items: IntentInput[] = [];
  const { reader } = readerOf(items);
  const { personId, restore } = await decided(reader);
  try {
    // No signal yet: intent 0, priority round(0.55 × 88) = 48, Cool; no why-now.
    let lead = await leadOf(personId);
    assert.deepEqual(
      [lead.qualificationStatus, lead.fitScore, lead.tier],
      ["qualified", 88, "cool"],
    );
    assert.deepEqual(keysOf(lead.why), ["fit", "gap"]);
    const row = await rowOf(personId);
    assert.deepEqual(
      [row.intentScore, row.priority, row.tier, row.scorerVersion, row.computedAt],
      [0, 48, "cool", "intent-v1", T0],
    );

    // A competitor comment at T0, named in a re-score: intent 53, priority 72 + 10, Hot.
    items.push(signal(personId, "evt_1", "competitor_engagement"));
    const page = (at: Date) => run(WS, () => rescorePage({ personIds: [personId] }, at));
    assert.deepEqual(await page(T0), { rescored: 0, skipped: 1, next: null });
    lead = await leadOf(personId);
    assert.deepEqual(
      [lead.qualificationStatus, lead.fitScore, lead.tier],
      ["qualified", 88, "hot"],
    );
    assert.deepEqual(keysOf(lead.why), ["fit", "why_now", "gap"]);
    const now = await rowOf(personId);
    assert.deepEqual(
      [now.intentScore, now.priority, now.tier, now.whyNowEventId, now.boostUntil],
      [53, 82, "hot", "evt_1", after(48)],
    );
    // Each part with its signal's date and its source's creator (gamma-p5-065).
    const part = { eventId: "evt_1", kind: "competitor_engagement", role: "comment" };
    assert.deepEqual(now.intentBreakdown, [
      { ...part, contribution: 6, at: T0.toISOString(), ownerUserId: null },
    ]);

    // Three days on, the boost is over: 48 and 70, Warm; then the person's own post, at once.
    await page(after(72));
    assert.deepEqual(
      [(await leadOf(personId)).tier, (await rowOf(personId)).priority],
      ["warm", 70],
    );
    items.push(signal(personId, "evt_2", "my_post_engagement", after(72)));
    await page(after(72));
    const last = await rowOf(personId);
    assert.deepEqual(
      [last.intentScore, last.priority, last.tier, last.whyNowEventId, last.boostUntil],
      [80, 94, "hot", "evt_2", after(120)],
    );
    lead = await leadOf(personId);
    assert.deepEqual(
      [lead.qualificationStatus, lead.fitScore, lead.tier],
      ["qualified", 88, "hot"],
    );
    assert.deepEqual((lead.why as { params: unknown }[])[1]?.params, {
      kind: "my_post_engagement",
      role: "comment",
      days: 0,
    });
    assert.equal(await decisions(), 0);
  } finally {
    restore();
  }
});

test("the lock: an intent update under way holds a decision back, which then writes its fields and the newest intent", async () => {
  const { reader, hold } = readerOf([]);
  const { personId, restore } = await decided(reader);
  const weigh = (weight: number) =>
    run(WS, (tx) => tx.criterion.updateMany({ where: { key: "must_haves" }, data: { weight } }));
  try {
    const held = hold();
    const update = run(WS, () => updateIntent(personId, after(1)));
    await held.inside;
    await weigh(60);
    const decision = run(WS, () => rescorePage({ personIds: [personId] }, after(2)));
    await waitingOnLock(personId);
    held.release();
    assert.equal(await update, true);
    assert.deepEqual(await decision, { rescored: 1, skipped: 0, next: null });
    const lead = await leadOf(personId);
    const row = await rowOf(personId);
    // The decision's fit, 74 with the heavier must, and its intent, the newest.
    assert.deepEqual([lead.fitScore, row.priority, row.computedAt], [74, 41, after(2)]);
  } finally {
    restore();
  }
});

test("the lock: a decision under way holds an intent update back, which then keeps the decision's fields and writes the newest intent", async () => {
  const { reader, hold } = readerOf([]);
  const { personId, snapshotId, restore } = await decided(reader);
  try {
    await run(WS, (tx) =>
      tx.criterion.updateMany({ where: { key: "must_haves" }, data: { weight: 60 } }),
    );
    await run(WS, () => rescorePage({ personIds: [personId] }, after(1)));
    assert.equal((await leadOf(personId)).fitScore, 74);
    await run(WS, (tx) =>
      tx.criterion.updateMany({ where: { key: "must_haves" }, data: { weight: 20 } }),
    );
    const held = hold();
    const decision = run(WS, () => rescorePage({ personIds: [personId] }, after(2)));
    await held.inside;
    const update = run(WS, () => updateIntent(personId, after(3)));
    await waitingOnLock(personId);
    held.release();
    assert.deepEqual(await decision, { rescored: 1, skipped: 0, next: null });
    assert.equal(await update, true);
    const lead = await leadOf(personId);
    const row = await rowOf(personId);
    // The decision gave the assessment's own snapshot back, fit 88; the update's intent is newer.
    assert.deepEqual(
      [lead.currentScoreSnapshotId, lead.fitScore, lead.qualificationStatus, row.computedAt],
      [snapshotId, 88, "qualified", after(3)],
    );
  } finally {
    restore();
  }
});
