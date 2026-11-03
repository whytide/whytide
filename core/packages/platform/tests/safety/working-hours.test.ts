// The safety case of beta-p0-050 (beta, "rules we keep": hard caps and working hours cannot be
// exceeded by anyone). Over many seeds and three zones, the random times drawn in the window that
// nextWindowAt gives for Monday to Friday 09:00 to 18:00 stay inside it, on a weekday, and no closer
// than the gap; a delay in business days from one of them lands inside a window too. The zones'
// clocks are read here with Intl alone, never with the helpers under test.
import assert from "node:assert/strict";
import test from "node:test";
import {
  addBusinessDays,
  instantAt,
  isWindowOpen,
  MONDAY_TO_FRIDAY,
  nextWindowAt,
  quotaDay,
  randomTimesInWindow,
  synthetic,
  throwsCode,
} from "../../index.ts";

const ZONES = ["Pacific/Auckland", "America/Los_Angeles", "Asia/Kolkata"];
const SEEDS = 250;
const HOURS = { start: "09:00", end: "18:00", days: MONDAY_TO_FRIDAY };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
/** Two years of starting instants, so the windows fall on both sides of every daylight-saving change. */
const FIRST_MS = Date.parse("2026-01-01T00:00:00Z");
const SPAN_MS = 730 * 86_400_000;
const MINUTE_MS = 60_000;
const MAX_COUNT = 40;
const MAX_GAP_MINUTES = 90;
const MAX_BUSINESS_DAYS = 15;
/** synthetic's sequence is 32-bit numbers over 2^32, so this reads it back exactly. */
const RANGE = 2 ** 32;
const JUST_BELOW_ONE = 1 - Number.EPSILON / 2;

type Generator = ReturnType<typeof synthetic>;
const seeded = (generator: Generator) => () => generator.int(RANGE) / RANGE;

const clocks = new Map<string, Intl.DateTimeFormat>();
/** The zone's clock at the instant, from Intl alone: `{ weekday: "Mon", time: "09:00" }`. */
function clock(at: Date, timeZone: string): { weekday: string; time: string } {
  let format = clocks.get(timeZone);
  if (format === undefined) {
    const options = { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit" } as const;
    format = new Intl.DateTimeFormat("en-US", { ...options, hourCycle: "h23" });
    clocks.set(timeZone, format);
  }
  const parts = format.formatToParts(at);
  const part = (type: string) => parts.find((each) => each.type === type)?.value ?? "";
  return { weekday: part("weekday"), time: `${part("hour")}:${part("minute")}` };
}

/** A window of the zone: from the first start nextWindowAt gives after a random instant, to that day's end. */
function windowOf(generator: Generator, zone: string): { from: Date; to: Date } {
  const from = nextWindowAt(new Date(FIRST_MS + generator.int(SPAN_MS)), zone, HOURS);
  return { from, to: instantAt(quotaDay(from, zone), HOURS.end, zone) };
}

function assertInWindow(time: Date, zone: string, window: { from: Date; to: Date }, what: string) {
  const local = clock(time, zone);
  assert.ok(window.from <= time && time < window.to, `${what} outside [from, to)`);
  assert.ok(WEEKDAYS.includes(local.weekday), `${what} on ${local.weekday}`);
  assert.ok(HOURS.start <= local.time && local.time < HOURS.end, `${what} at ${local.time}`);
  assert.equal(isWindowOpen(time, zone, HOURS), true, `${what} with the window closed`);
}

test("random times in the window nextWindowAt gives stay inside it, on a weekday, at least the gap apart, over many seeds and three zones", () => {
  let drawn = 0;
  for (let seed = 0; seed < SEEDS; seed++) {
    for (const zone of ZONES) {
      const generator = synthetic(`working-hours:${zone}:${seed}`);
      const window = windowOf(generator, zone);
      const count = 1 + generator.int(MAX_COUNT);
      const minGapMs = MINUTE_MS * (1 + generator.int(MAX_GAP_MINUTES));
      const random = seeded(generator);
      const times = randomTimesInWindow({ ...window, count, minGapMs, random });
      const what = `seed ${seed} in ${zone}`;
      const fits = Math.floor((window.to.getTime() - window.from.getTime() - 1) / minGapMs) + 1;
      assert.equal(times.length, Math.min(count, fits), `${what}: as many as fit`);
      times.forEach((time, i) => {
        assertInWindow(time, zone, window, `${what}, time ${i}`);
        const previous = times[i - 1];
        if (previous === undefined) return;
        assert.ok(time.getTime() - previous.getTime() >= minGapMs, `${what}, time ${i}: gap`);
      });
      const n = generator.int(MAX_BUSINESS_DAYS + 1);
      for (const time of times) {
        const later = addBusinessDays(time, n, zone, MONDAY_TO_FRIDAY);
        assert.ok(WEEKDAYS.includes(clock(later, zone).weekday), `${what}: ${n} business days`);
        assert.equal(clock(later, zone).time, clock(time, zone).time, `${what}: the clock kept`);
        assert.equal(isWindowOpen(later, zone, HOURS), true, `${what}: ${n} business days`);
      }
      drawn += times.length;
    }
  }
  assert.ok(drawn > SEEDS * ZONES.length, `the cases drew ${drawn} times`);
});

test("the extremes of the source keep every time inside the window; a source outside [0, 1) is refused, never placed", () => {
  for (const zone of ZONES) {
    const window = windowOf(synthetic(`extremes:${zone}`), zone);
    const ask = (random: () => number) =>
      randomTimesInWindow({ ...window, count: 30, minGapMs: 17 * MINUTE_MS, random });
    for (const value of [0, JUST_BELOW_ONE]) {
      const times = ask(() => value);
      assert.equal(times.length, 30);
      times.forEach((time, i) => assertInWindow(time, zone, window, `${value} in ${zone}, ${i}`));
    }
    for (const value of [1, -Number.EPSILON, Number.NaN, 2]) {
      throwsCode(() => ask(() => value), "time_argument_invalid");
    }
  }
});
