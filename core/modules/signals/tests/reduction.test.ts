// The reduction's rule (alpha-p10-020; README.md "Reduction"): when a kind's evidence is due. The
// reduction itself, its workflow, its tick and the command, is the worker's test:
// core/apps/worker/tests/signals-reduction.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { reductionCuts } from "../domain/reduce/reduce.ts";
import { registeredSourceKinds } from "../sources/registry.ts";

const now = new Date("2026-10-27T03:00:00.000Z");
const kind = (event: string, lookbackDays: number) => ({ lookbackDays, event: { kind: event } });

test("evidence is due once captured before its kind's lookback: post engagements after 30 days; an event kind two kinds share takes the shorter lookback, one no kind declares the shortest", () => {
  const registered = reductionCuts(registeredSourceKinds().values(), now);
  assert.equal(registered?.cutOf("post_engagement").toISOString(), "2026-09-27T03:00:00.000Z");
  const cuts = reductionCuts([kind("a", 30), kind("b", 90), kind("a", 14)], now);
  assert.deepEqual(
    ["a", "b", "gone"].map((eventKind) => cuts?.cutOf(eventKind).toISOString()),
    ["2026-10-13T03:00:00.000Z", "2026-07-29T03:00:00.000Z", "2026-10-13T03:00:00.000Z"],
  );
  assert.equal(cuts?.latest.toISOString(), "2026-10-13T03:00:00.000Z");
  assert.equal(reductionCuts([], now), null);
});
