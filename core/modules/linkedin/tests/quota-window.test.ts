// The quota day and the working-hours window (domain/quota/window.ts), the business logic under
// acceptance criteria 2 and 3: a date in the account's zone that turns at local midnight, a window
// open from start until before end on working days, and the next start across a weekend that ends
// daylight-saving time in Paris (2026-10-25).
import assert from "node:assert/strict";
import test from "node:test";
import { isWindowOpen, nextQuotaDayAt, nextWindowAt, quotaDay } from "../domain/quota/window.ts";

const iso = (date: Date) => date.toISOString();
const at = (value: string) => new Date(value);

test("the quota day turns at local midnight; the window opens at start, closes at end, and next opens after the weekend in its new offset", () => {
  assert.equal(quotaDay(at("2026-10-23T10:59:59.999Z"), "Pacific/Auckland"), "2026-10-23");
  assert.equal(quotaDay(at("2026-10-23T11:00:00Z"), "Pacific/Auckland"), "2026-10-24");
  assert.equal(quotaDay(at("2026-10-23T11:00:00Z"), "America/Los_Angeles"), "2026-10-23");
  const angeles = nextQuotaDayAt(at("2026-10-22T17:00:00Z"), "America/Los_Angeles");
  assert.equal(iso(angeles), "2026-10-23T07:00:00.000Z");

  const hours = { start: "08:30", end: "18:00", days: [1, 2, 3, 4, 5] };
  const open = (value: string) => isWindowOpen(at(value), "Europe/Paris", hours);
  // Friday 2026-10-23 in Paris is CEST, UTC+2; Monday 2026-10-26 is CET, UTC+1.
  assert.deepEqual(
    [open("2026-10-23T06:29:59Z"), open("2026-10-23T06:30:00Z"), open("2026-10-23T15:59:59Z")],
    [false, true, true],
  );
  assert.equal(open("2026-10-23T16:00:00Z"), false);
  assert.equal(open("2026-10-24T10:00:00Z"), false);
  const next = (value: string) => iso(nextWindowAt(at(value), "Europe/Paris", hours));
  assert.equal(next("2026-10-23T05:00:00Z"), "2026-10-23T06:30:00.000Z");
  assert.equal(next("2026-10-23T16:00:00Z"), "2026-10-26T07:30:00.000Z");
  assert.equal(next("2026-10-25T01:30:00Z"), "2026-10-26T07:30:00.000Z");
});
