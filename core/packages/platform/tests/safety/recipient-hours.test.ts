// The safety case of gamma-p0-070 (gamma, "rules we keep": caps, spacing, unsubscribe link and
// footer on every cold email; the time part). Over many seeds and five zones, chains of spaced
// sends, half of them starting just before a daylight-saving change, never place one outside the
// window they were asked for, nor closer to the one before than the minimum gap: in the
// recipient's business hours of sendWindowFor when the zone is known, in the sender's own schedule
// when it is not, and in the windows a change empties or closes early. The zones' clocks and
// changes are read here with Intl alone, never with the helpers under test.
import assert from "node:assert/strict";
import test from "node:test";
import {
  instantAt,
  type LocalSchedule,
  nextSpacedTime,
  RECIPIENT_BUSINESS_HOURS,
  sendWindowFor,
  synthetic,
  throwsCode,
} from "../../index.ts";

const KOLKATA = "Asia/Kolkata";
/** Changes in both hemispheres, a half-hour offset without one, and a change on a Friday (Jerusalem). */
const ZONES = [
  "America/Los_Angeles",
  "Europe/Berlin",
  KOLKATA,
  "Pacific/Auckland",
  "Asia/Jerusalem",
];
const SEEDS = 80;
const SENDS = 50;
/** Two years of starting instants: every zone but Kolkata's changes four times in them. */
const FIRST_MS = Date.parse("2026-01-01T00:00:00Z");
const DAY_MS = 86_400_000;
const SPAN_DAYS = 730;
const SPAN_MS = SPAN_DAYS * DAY_MS;
const CHANGES = 4;
/** Where a chain near a change starts: from three days before it to a day after. */
const BEFORE_CHANGE_MS = 3 * DAY_MS;
const AROUND_CHANGE_MS = 4 * DAY_MS;
const MINUTE_MS = 60_000;
/**
 * Email's gaps (F11 §5.1), and others drawn to the millisecond: a minimum up to an hour, a spread
 * up to 12 hours, longer than the business hours.
 */
const EMAIL_GAPS = { minGapMs: 4 * MINUTE_MS, maxGapMs: 12 * MINUTE_MS };
const MAX_MIN_GAP_MS = 60 * MINUTE_MS;
const MAX_SPREAD_MS = 720 * MINUTE_MS;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_MINUTES = 24 * 60;
/** synthetic's sequence is 32-bit numbers over 2^32, so this reads it back exactly. */
const RANGE = 2 ** 32;
const JUST_BELOW_ONE = 1 - Number.EPSILON / 2;
/** A sender's schedule where the recipient's zone is known: sendWindowFor never uses it there. */
const SENDER: LocalSchedule = {
  timeZone: "Europe/London",
  start: "09:00",
  end: "17:30",
  days: [1, 2, 3, 4, 5],
};

type Generator = ReturnType<typeof synthetic>;
type Gaps = { minGapMs: number; maxGapMs: number };
const seeded = (generator: Generator) => () => generator.int(RANGE) / RANGE;
const sequence = (values: number[]) => () => values.shift() ?? Number.NaN;

const clocks = new Map<string, Intl.DateTimeFormat>();
/** The zone's clock at the instant, from Intl alone: `{ isoDay: 1, time: "08:30" }`. */
function clock(at: Date, timeZone: string): { isoDay: number; time: string } {
  let format = clocks.get(timeZone);
  if (format === undefined) {
    const options = { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit" } as const;
    format = new Intl.DateTimeFormat("en-US", { ...options, hourCycle: "h23" });
    clocks.set(timeZone, format);
  }
  const parts = format.formatToParts(at);
  const part = (type: string) => parts.find((each) => each.type === type)?.value ?? "";
  const isoDay = WEEKDAYS.indexOf(part("weekday")) + 1;
  return { isoDay, time: `${part("hour")}:${part("minute")}` };
}

const changes = new Map<string, number[]>();
/** For each change of the zone's offset in the two years, the UTC noon before it, from Intl alone. */
function changesOf(timeZone: string): number[] {
  let found = changes.get(timeZone);
  if (found !== undefined) return found;
  const format = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
  const offset = (at: number) =>
    format.formatToParts(at).find((part) => part.type === "timeZoneName")?.value;
  found = [];
  for (let day = 0; day < SPAN_DAYS; day++) {
    const noon = FIRST_MS + day * DAY_MS + DAY_MS / 2;
    if (offset(noon) !== offset(noon + DAY_MS)) found.push(noon);
  }
  changes.set(timeZone, found);
  return found;
}

/** A chain's first `after`: near one of the zone's changes, or anywhere in the two years. */
function firstAfter(generator: Generator, timeZone: string, nearChange: boolean): Date {
  const near = changesOf(timeZone);
  if (!nearChange || near.length === 0) return new Date(FIRST_MS + generator.int(SPAN_MS));
  return new Date(generator.pick(near) - BEFORE_CHANGE_MS + generator.int(AROUND_CHANGE_MS));
}

function assertSafe(answer: Date, after: Date, gaps: Gaps, schedule: LocalSchedule, what: string) {
  const { isoDay, time } = clock(answer, schedule.timeZone);
  assert.ok(answer.getTime() - after.getTime() >= gaps.minGapMs, `${what}: closer than the gap`);
  assert.ok(schedule.days.includes(isoDay), `${what}: on ISO day ${isoDay}`);
  assert.ok(schedule.start <= time && time < schedule.end, `${what}: at ${time}`);
}

function randomGaps(generator: Generator): Gaps {
  const minGapMs = generator.int(MAX_MIN_GAP_MS + 1);
  return { minGapMs, maxGapMs: minGapMs + generator.int(MAX_SPREAD_MS + 1) };
}

/** Any schedule localSchedule takes: start before end, a non-empty set of ISO weekdays. */
function randomSchedule(generator: Generator, timeZone: string): LocalSchedule {
  const hhmm = (minutes: number) =>
    `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  const start = generator.int(DAY_MINUTES - 1);
  const end = start + 1 + generator.int(DAY_MINUTES - 1 - start);
  const mask = 1 + generator.int(2 ** WEEKDAYS.length - 1);
  const days = [1, 2, 3, 4, 5, 6, 7].filter((day) => (mask >> (day - 1)) & 1);
  return { timeZone, start: hhmm(start), end: hhmm(end), days };
}

/** A chain of sends from `first`, each spaced from the one before, every one asserted safe. */
function chain(
  first: Date,
  schedule: LocalSchedule,
  gaps: Gaps,
  random: () => number,
  what: string,
) {
  let after = first;
  const { timeZone } = schedule;
  for (let send = 0; send < SENDS; send++) {
    const answer = nextSpacedTime({ after, ...gaps, timeZone, hours: schedule, random });
    assertSafe(answer, after, gaps, schedule, `${what}, send ${send}`);
    after = answer;
  }
}

/** Each seed's case: email's gaps or drawn ones, a start near a change or anywhere. */
function caseOf(generator: Generator, seed: number, zone: string) {
  const gaps = seed % 2 === 0 ? EMAIL_GAPS : randomGaps(generator);
  const first = firstAfter(generator, zone, seed % 4 < 2);
  return { gaps, first, random: seeded(generator) };
}

test("in the recipient's business hours, no spaced send falls outside the window, at a weekend or closer than the minimum gap, over many seeds and five zones", () => {
  for (const zone of ZONES) assert.equal(changesOf(zone).length, zone === KOLKATA ? 0 : CHANGES);
  for (let seed = 0; seed < SEEDS; seed++) {
    for (const zone of ZONES) {
      const generator = synthetic(`recipient-hours:${zone}:${seed}`);
      const window = sendWindowFor({ recipientZone: zone, sender: SENDER });
      assert.equal(window.used, "recipient");
      assert.deepEqual(window.schedule, { timeZone: zone, ...RECIPIENT_BUSINESS_HOURS });
      const { gaps, first, random } = caseOf(generator, seed, zone);
      chain(first, window.schedule, gaps, random, `seed ${seed} in ${zone}`);
    }
  }
});

test("with the recipient's zone unknown, no spaced send falls outside the sender's own schedule or closer than the minimum gap, whatever the schedule", () => {
  for (let seed = 0; seed < SEEDS; seed++) {
    for (const zone of ZONES) {
      const generator = synthetic(`sender-hours:${zone}:${seed}`);
      const sender = randomSchedule(generator, zone);
      const window = sendWindowFor({ recipientZone: null, sender });
      assert.equal(window.used, "sender");
      assert.deepEqual(window.schedule, sender);
      const { gaps, first, random } = caseOf(generator, seed, zone);
      const what = `seed ${seed}, ${sender.start} to ${sender.end} in ${zone}`;
      chain(first, window.schedule, gaps, random, what);
    }
  }
});

test("a window that a daylight-saving change empties or closes early is never answered: the send goes to the next one", () => {
  const angeles = "America/Los_Angeles";
  // Los Angeles springs forward on Sunday 2026-03-08 at 02:00: that Sunday has no 02:00 to 03:00.
  const empty: LocalSchedule = { timeZone: angeles, start: "02:00", end: "03:00", days: [7] };
  const saturday = instantAt("2026-03-07", "23:00", angeles);
  for (const value of [0, 0.5, JUST_BELOW_ONE]) {
    const ask = { after: saturday, ...EMAIL_GAPS, timeZone: angeles, hours: empty };
    const answer = nextSpacedTime({ ...ask, random: () => value });
    assertSafe(answer, saturday, EMAIL_GAPS, empty, `the emptied window, draw ${value}`);
    assert.ok(answer.getTime() > Date.parse("2026-03-14T00:00:00Z"), "the next Sunday's window");
  }
  // 01:00 to 02:30 that Sunday is open until 02:00 only: a draw past it tries the next window.
  const early: LocalSchedule = { timeZone: angeles, start: "01:00", end: "02:30", days: [7] };
  const gaps = { minGapMs: 60 * MINUTE_MS, maxGapMs: 180 * MINUTE_MS };
  const after = instantAt("2026-03-07", "22:00", angeles);
  const random = sequence([0.5, 0.9, 0.1]);
  const answer = nextSpacedTime({ after, ...gaps, timeZone: angeles, hours: early, random });
  assertSafe(answer, after, gaps, early, "the window closed early");
});

test("the extremes of the source keep every send inside the window and the gap; a source outside [0, 1) is refused, never placed", () => {
  for (const zone of ZONES) {
    const window = sendWindowFor({ recipientZone: zone, sender: SENDER }).schedule;
    const hours = RECIPIENT_BUSINESS_HOURS;
    // A Tuesday morning, a Friday a minute before the end, a Saturday, a Monday before the start.
    const afters = [
      instantAt("2026-06-16", "10:00", zone),
      instantAt("2026-06-19", "17:59", zone),
      instantAt("2026-06-20", "12:00", zone),
      instantAt("2026-06-22", "08:20", zone),
    ];
    for (const after of afters) {
      for (const value of [0, JUST_BELOW_ONE]) {
        const ask = { after, ...EMAIL_GAPS, timeZone: zone, hours, random: () => value };
        assertSafe(nextSpacedTime(ask), after, EMAIL_GAPS, window, `${value} in ${zone}`);
      }
      for (const value of [1, -Number.EPSILON, Number.NaN, 2]) {
        const ask = { after, ...EMAIL_GAPS, timeZone: zone, hours, random: () => value };
        throwsCode(() => nextSpacedTime(ask), "time_argument_invalid");
      }
    }
    // The first draw lands after Friday's end; the second, which places Monday's, is broken.
    const friday = { after: afters[1] as Date, ...EMAIL_GAPS, timeZone: zone, hours };
    throwsCode(
      () => nextSpacedTime({ ...friday, random: sequence([JUST_BELOW_ONE, 1]) }),
      "time_argument_invalid",
    );
  }
});
