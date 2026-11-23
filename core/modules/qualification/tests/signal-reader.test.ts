// The signal reader's registry (README "Intent and priority"): one reader per process, a second
// registration refused at start; a test's fake put in place and taken out; with no reader, a decision
// writes no intent row and the lead keeps its fit tier, and an intent update computes nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLeadForPerson } from "@whytide/contacts";
import { withTestDb } from "@whytide/db/testing";
import { isAppError } from "@whytide/platform";
import { assessPerson } from "../domain/assess/assess-person.ts";
import { scoreSnapshot, updateIntent } from "../domain/score/score-snapshot.ts";
import {
  defineSignalReader,
  type SignalReader,
  signalReader,
  useSignalReader,
} from "../domain/signal-reader.ts";
import { answer, contextOf, fake, run, seed } from "./fixtures/assess.ts";

withTestDb();
const WS = "wsp_qualification_reader";
const reader = (): SignalReader => ({ intentInputs: async () => [], excerpts: async () => [] });

test("one reader per process: the first registration holds, a second fails with signal_reader_duplicate (500)", () => {
  const first = reader();
  defineSignalReader(first);
  try {
    assert.equal(signalReader(), first);
    assert.throws(
      () => defineSignalReader(reader()),
      (error) =>
        isAppError(error) && error.code === "signal_reader_duplicate" && error.status === 500,
    );
    assert.equal(signalReader(), first);
  } finally {
    useSignalReader(undefined);
  }
  assert.equal(signalReader(), undefined);
});

test("useSignalReader puts a test's fake in place, and its function puts back the one before", () => {
  const stub = reader();
  const restore = useSignalReader(stub);
  assert.equal(signalReader(), stub);
  const inner = useSignalReader(undefined);
  assert.equal(signalReader(), undefined);
  inner();
  assert.equal(signalReader(), stub);
  restore();
  assert.equal(signalReader(), undefined);
});

test("with no reader, a decision writes no intent row and the lead keeps its fit tier; an intent update computes nothing", async () => {
  assert.equal(signalReader(), undefined);
  const personId = await seed(WS);
  await run(WS, () =>
    createLeadForPerson({ personId, source: { kind: "imported", ref: "imp_1" } }),
  );
  fake.reset();
  fake.script(answer());
  const assessed = await assessPerson({ personId, icpVersion: 1 }, contextOf(WS));
  if (assessed.status !== "assessed") throw new Error(assessed.status);
  await run(WS, () => scoreSnapshot(assessed.snapshotId));
  const lead = await run(WS, (tx) => tx.lead.findFirstOrThrow({ where: { personId } }));
  const keys = (lead.why as { key: string }[]).map(({ key }) => key);
  assert.deepEqual(
    [lead.fitScore, lead.tier, keys],
    [88, "hot", ["qualification.why.fit", "qualification.why.gap"]],
  );
  assert.equal(await run(WS, () => updateIntent(personId)), false);
  assert.deepEqual(await run(WS, (tx) => tx.intentScore.findMany()), []);
  const again = await run(WS, (tx) => tx.lead.findFirstOrThrow({ where: { personId } }));
  assert.deepEqual(again.updatedAt, lead.updatedAt);
});
