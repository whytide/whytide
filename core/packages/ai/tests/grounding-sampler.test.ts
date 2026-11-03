// The grounding sample's seeding and weeks, pure (README.md "The grounding sample"): the same refs
// and week draw the same sample in any order, another week another; an ISO week's bounds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { drawRefs, isoWeek } from "../grounding-sample/sample.ts";

const refs = Array.from({ length: 50 }, (_, i) => `mdr_${String(i).padStart(2, "0")}`);

test("drawRefs: twenty of fifty, the same for the same week in any order, another for another week", () => {
  const drawn = drawRefs(refs, 20, "2026-W43");
  assert.equal(drawn.length, 20);
  assert.equal(new Set(drawn).size, 20);
  assert.ok(drawn.every((ref) => refs.includes(ref)));
  assert.deepEqual(drawRefs([...refs].reverse(), 20, "2026-W43"), drawn);
  assert.deepEqual(drawRefs([...refs, ...refs], 20, "2026-W43"), drawn);
  assert.notDeepEqual(drawRefs(refs, 20, "2026-W44"), drawn);
  assert.deepEqual(drawRefs(refs.slice(0, 7), 20, "2026-W43").sort(), refs.slice(0, 7));
  assert.deepEqual(drawRefs([], 20, "2026-W43"), []);
});

test("isoWeek: Monday 00:00 UTC to the next; week 53 only in a year that has it; other shapes refused", () => {
  const range = (week: string) => {
    const { from, to } = isoWeek(week);
    return [from.toISOString(), to.toISOString()];
  };
  assert.deepEqual(range("2026-W43"), ["2026-10-19T00:00:00.000Z", "2026-10-26T00:00:00.000Z"]);
  assert.deepEqual(range("2026-W01"), ["2025-12-29T00:00:00.000Z", "2026-01-05T00:00:00.000Z"]);
  assert.deepEqual(range("2026-W53"), ["2026-12-28T00:00:00.000Z", "2027-01-04T00:00:00.000Z"]);
  for (const week of ["2025-W53", "2026-W00", "2026-W54", "2026-43", "26-W43", "2026-W4"]) {
    assert.throws(() => isoWeek(week), { code: "ai_grounding_input_invalid" }, week);
  }
});
