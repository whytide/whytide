// periodFor (docs/concepts.md "Period"), the unit test: the calendar month in UTC, whatever the offset
// the instant was written with.
import assert from "node:assert/strict";
import test from "node:test";
import { periodFor } from "../domain/period.ts";

const bounds = (at: string) => {
  const { start, end } = periodFor(new Date(at));
  return [start.toISOString(), end.toISOString()];
};
const OCTOBER = ["2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"];

test("periodFor: the calendar month in UTC holding the instant, its end excluded", () => {
  assert.deepEqual(bounds("2026-10-22T12:30:00Z"), OCTOBER);
  assert.deepEqual(bounds("2026-10-01T00:00:00Z"), OCTOBER);
  assert.deepEqual(bounds("2026-10-31T23:59:59.999Z"), OCTOBER);
  assert.deepEqual(bounds("2026-11-01T00:00:00Z")[0], OCTOBER[1]);
  // 01:00 on November 1st in Kolkata is still October in UTC.
  assert.deepEqual(bounds("2026-11-01T01:00:00+05:30"), OCTOBER);
  assert.deepEqual(bounds("2026-12-31T23:00:00Z"), [
    "2026-12-01T00:00:00.000Z",
    "2027-01-01T00:00:00.000Z",
  ]);
  assert.deepEqual(bounds("2028-02-29T08:00:00Z"), [
    "2028-02-01T00:00:00.000Z",
    "2028-03-01T00:00:00.000Z",
  ]);
});
