// The first message's due time without a database (beta-p4-050; domain/acceptance.ts; docs/flows.md
// "Acceptance → the first message"): inside the window, near its end, at night, on a Friday evening
// and across daylight-saving changes, in the sender account's zone with its hours, its days cut to
// Monday to Friday; no due time without a weekday, and none from a broken source. The seeded bounds
// are tests/safety/first-message-timing.test.ts; the subscriber through the outbox, the worker's
// tests/campaigns-acceptance.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { isWindowOpen, synthetic, throwsCode } from "@whytide/platform";
import { type AccountHours, firstMessageDueAt } from "../domain/acceptance.ts";

const HOUR_MS = 3_600_000;
const RANGE = 2 ** 32;
const NINE_TO_SIX = { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] };

const zoned = (timeZone: string, workingHours = NINE_TO_SIX): AccountHours => ({
  timeZone,
  workingHours,
});
const UTC = zoned("UTC");
const draw = (value: number) => () => value;
/** The due time, in ISO, of an acceptance detected at `detected`, with the one draw `value`. */
const dueFor = (detected: string, account: AccountHours, value: number) =>
  firstMessageDueAt(new Date(detected), account, draw(value))?.toISOString() ?? null;

test("inside the window: due 1 to 3 hours after the detection, at the draw's share of the two hours", () => {
  // Wednesday 28 October 2026, 10:00 UTC, in a 09:00 to 18:00 window.
  const detected = "2026-10-28T10:00:00.000Z";
  assert.equal(dueFor(detected, UTC, 0), "2026-10-28T11:00:00.000Z");
  assert.equal(dueFor(detected, UTC, 0.25), "2026-10-28T11:30:00.000Z");
  assert.equal(dueFor(detected, UTC, 0.5), "2026-10-28T12:00:00.000Z");
  assert.equal(dueFor(detected, UTC, (RANGE - 1) / RANGE), "2026-10-28T12:59:59.999Z");
  const s = synthetic("campaigns-acceptance-inside");
  for (let index = 0; index < 200; index += 1) {
    const due = firstMessageDueAt(new Date(detected), UTC, () => s.int(RANGE) / RANGE);
    const after = (due?.getTime() ?? 0) - Date.parse(detected);
    assert.ok(after >= HOUR_MS && after < 3 * HOUR_MS, `${after} ms after the detection`);
  }
});

test("near the window's end: a draw before the end stays; one at or past it moves to the next weekday's start", () => {
  // Wednesday, 16:30 UTC: the draw runs from 17:30 to 19:30, and the window closes at 18:00.
  const detected = "2026-10-28T16:30:00.000Z";
  assert.equal(dueFor(detected, UTC, 0), "2026-10-28T17:30:00.000Z");
  assert.equal(dueFor(detected, UTC, 0.2), "2026-10-28T17:54:00.000Z");
  assert.equal(dueFor(detected, UTC, 0.25), "2026-10-29T09:00:00.000Z");
  assert.equal(dueFor(detected, UTC, 0.5), "2026-10-29T09:00:00.000Z");
});

test("at night: the next window start, that morning's or the next weekday's, in the account's zone", () => {
  // Tuesday 23:00 UTC: the draw falls after midnight, before Wednesday's window.
  assert.equal(dueFor("2026-10-27T23:00:00.000Z", UTC, 0.5), "2026-10-28T09:00:00.000Z");
  // Wednesday 03:00 UTC: the same morning's start.
  assert.equal(dueFor("2026-10-28T03:00:00.000Z", UTC, 0.5), "2026-10-28T09:00:00.000Z");
  // Thursday 01:30 in Kolkata (UTC+05:30), Wednesday 20:00 UTC: Thursday 09:00 there.
  const kolkata = zoned("Asia/Kolkata");
  assert.equal(dueFor("2026-10-28T20:00:00.000Z", kolkata, 0.5), "2026-10-29T03:30:00.000Z");
});

test("a Friday evening's acceptance: Monday's start, Saturday and Sunday passed over in the account's zone, even when the account's days hold them", () => {
  // Friday 30 October 2026, 17:30 UTC: the draw falls after the window.
  const friday = "2026-10-30T17:30:00.000Z";
  const monday = "2026-11-02T09:00:00.000Z";
  assert.equal(dueFor(friday, UTC, 0.5), monday);
  const everyDay = zoned("UTC", { ...NINE_TO_SIX, days: [1, 2, 3, 4, 5, 6, 7] });
  assert.equal(dueFor(friday, everyDay, 0.5), monday);
  // A Saturday morning, inside the account's hours and days: Monday's start all the same.
  assert.equal(dueFor("2026-10-31T10:00:00.000Z", everyDay, 0.5), monday);
  // Monday to Wednesday only: a Wednesday evening's waits for Monday too.
  const early = zoned("UTC", { ...NINE_TO_SIX, days: [1, 2, 3] });
  assert.equal(dueFor("2026-10-28T17:30:00.000Z", early, 0.5), monday);
  // Friday 17:30 in Auckland (UTC+13) is 04:30 UTC; Monday 09:00 there is Sunday 20:00 UTC.
  const auckland = zoned("Pacific/Auckland");
  assert.equal(dueFor("2026-10-30T04:30:00.000Z", auckland, 0.5), "2026-11-01T20:00:00.000Z");
});

test("across daylight-saving changes: the start keeps its local clock time, and a start whose whole window a spring-forward skips is passed over", () => {
  // Los Angeles moves to summer time on Sunday 8 March 2026: Friday 17:30 PST, then Monday 09:00 PDT.
  const angeles = zoned("America/Los_Angeles");
  assert.equal(dueFor("2026-03-07T01:30:00.000Z", angeles, 0.5), "2026-03-09T16:00:00.000Z");
  // And back on Sunday 1 November 2026: Friday 17:30 PDT, then Monday 09:00 PST.
  assert.equal(dueFor("2026-10-31T00:30:00.000Z", angeles, 0.5), "2026-11-02T17:00:00.000Z");
  // Israel moves on Friday 27 March 2026 at 02:00: a 02:00 to 02:45 window is skipped whole that
  // day, so a Thursday evening's acceptance waits for Monday 02:00 summer time.
  const skipped = { ...NINE_TO_SIX, start: "02:00", end: "02:45" };
  const thursday = "2026-03-26T18:00:00.000Z"; // 20:00 in Jerusalem
  const due = firstMessageDueAt(new Date(thursday), zoned("Asia/Jerusalem", skipped), draw(0.5));
  assert.equal(due?.toISOString(), "2026-03-29T23:00:00.000Z");
  assert.ok(due !== null && isWindowOpen(due, "Asia/Jerusalem", skipped));
  // A window whose start alone is skipped opens an hour later that Friday, at 03:30 summer time.
  const late = zoned("Asia/Jerusalem", { ...NINE_TO_SIX, start: "02:30" });
  assert.equal(dueFor(thursday, late, 0.5), "2026-03-27T00:30:00.000Z");
});

test("no due time for an account whose days hold no weekday, and none from a broken source", () => {
  const weekends = zoned("UTC", { ...NINE_TO_SIX, days: [6, 7] });
  assert.equal(dueFor("2026-10-28T10:00:00.000Z", weekends, 0.5), null);
  const detected = new Date("2026-10-28T10:00:00.000Z");
  for (const value of [1, -0.1, Number.NaN]) {
    throwsCode(() => firstMessageDueAt(detected, UTC, draw(value)), "time_argument_invalid");
  }
});
