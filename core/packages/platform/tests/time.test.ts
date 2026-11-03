// beta-p0-050: business days, the window helpers moved from linkedin and random times, all imported
// from the package's entry, in Pacific/Auckland, America/Los_Angeles and Asia/Kolkata (a half-hour
// offset without daylight saving), across weekends and daylight-saving changes. The zones' clocks
// are read with Intl alone. The safety case is tests/safety/working-hours.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import {
  addBusinessDays,
  instantAt,
  isWindowOpen,
  MONDAY_TO_FRIDAY,
  nextQuotaDayAt,
  nextWindowAt,
  quotaDay,
  randomTimesInWindow,
  synthetic,
  throwsCode,
} from "../index.ts";

const ZONES = ["Pacific/Auckland", "America/Los_Angeles", "Asia/Kolkata"];
const ANGELES = "America/Los_Angeles";
const AUCKLAND = "Pacific/Auckland";
const KOLKATA = "Asia/Kolkata";
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
const MINUTE_MS = 60_000;
const RANGE = 2 ** 32;
const JUST_BELOW_ONE = 1 - Number.EPSILON / 2;
const INVALID = "time_argument_invalid";

const iso = (date: Date) => date.toISOString();
const at = (value: string) => new Date(value);

/** The zone's clock at the instant, from Intl alone: `Tue 2026-06-16 17:00`. */
function reads(instant: Date, timeZone: string): string {
  const options = { timeZone, weekday: "short", hourCycle: "h23" } as const;
  const parts = new Intl.DateTimeFormat("en-US", {
    ...options,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) => parts.find((each) => each.type === type)?.value ?? "";
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  return `${part("weekday")} ${date} ${part("hour")}:${part("minute")}`;
}

/** The instant the zone's clock reads as `Thu 2026-06-11 17:00`, the reading checked with Intl. */
function local(reading: string, timeZone: string): Date {
  const instant = instantAt(reading.slice(4, 14), reading.slice(15), timeZone);
  assert.equal(reads(instant, timeZone), reading, `the fixture ${reading} in ${timeZone}`);
  return instant;
}

/** The zone's clock `n` business days after the reading. */
const later = (
  reading: string,
  n: number,
  zone: string,
  days: readonly number[] = MONDAY_TO_FRIDAY,
) => reads(addBusinessDays(local(reading, zone), n, zone, days), zone);

test("3 business days from a Thursday 17:00 is the next Tuesday 17:00, from a Friday the next Wednesday; 1 from a Saturday 10:00 is the Monday 10:00, in every zone", () => {
  for (const zone of ZONES) {
    assert.equal(later("Thu 2026-06-11 17:00", 3, zone), "Tue 2026-06-16 17:00");
    assert.equal(later("Fri 2026-06-12 17:00", 3, zone), "Wed 2026-06-17 17:00");
    assert.equal(later("Sat 2026-06-13 10:00", 1, zone), "Mon 2026-06-15 10:00");
    assert.equal(later("Thu 2026-06-11 17:00", 10, zone), "Thu 2026-06-25 17:00");
    assert.equal(later("Tue 2026-06-09 12:00", 4, zone, [1, 3, 5]), "Wed 2026-06-17 12:00");
    const wednesday = local("Wed 2026-06-10 11:45", zone);
    assert.equal(iso(addBusinessDays(wednesday, 0, zone, MONDAY_TO_FRIDAY)), iso(wednesday));
  }
  // Asia/Kolkata is UTC+05:30 all year: the same local results, half an hour off the UTC hour.
  const thursday = at("2026-06-11T11:30:00Z");
  assert.equal(reads(thursday, KOLKATA), "Thu 2026-06-11 17:00");
  const tuesday = addBusinessDays(thursday, 3, KOLKATA, MONDAY_TO_FRIDAY);
  assert.equal(iso(tuesday), "2026-06-16T11:30:00.000Z");
  assert.equal(quotaDay(at("2026-06-14T18:29:59Z"), KOLKATA), "2026-06-14");
  assert.equal(
    iso(nextQuotaDayAt(at("2026-06-14T12:00:00Z"), KOLKATA)),
    "2026-06-14T18:30:00.000Z",
  );
});

test("across a daylight-saving change the local clock time is kept; a time the change skips lands an hour later", () => {
  // Los Angeles springs forward on Sunday 2026-03-08 and falls back on Sunday 2026-11-01;
  // Auckland falls back on Sunday 2026-04-05 and springs forward on Sunday 2026-09-27.
  const weeks = [
    [
      ANGELES,
      ["2026-03-05", "2026-03-06", "2026-03-07"],
      ["2026-03-10", "2026-03-11", "2026-03-09"],
    ],
    [
      ANGELES,
      ["2026-10-29", "2026-10-30", "2026-10-31"],
      ["2026-11-03", "2026-11-04", "2026-11-02"],
    ],
    [
      AUCKLAND,
      ["2026-04-02", "2026-04-03", "2026-04-04"],
      ["2026-04-07", "2026-04-08", "2026-04-06"],
    ],
    [
      AUCKLAND,
      ["2026-09-24", "2026-09-25", "2026-09-26"],
      ["2026-09-29", "2026-09-30", "2026-09-28"],
    ],
  ] as const;
  for (const [zone, [thu, fri, sat], [tue, wed, mon]] of weeks) {
    assert.equal(later(`Thu ${thu} 17:00`, 3, zone), `Tue ${tue} 17:00`);
    assert.equal(later(`Fri ${fri} 17:00`, 3, zone), `Wed ${wed} 17:00`);
    assert.equal(later(`Sat ${sat} 10:00`, 1, zone), `Mon ${mon} 10:00`);
    const hours = { start: "09:00", end: "18:00", days: MONDAY_TO_FRIDAY };
    assert.equal(
      reads(nextWindowAt(local(`Fri ${fri} 18:00`, zone), zone, hours), zone),
      `Mon ${mon} 09:00`,
    );
  }
  // The offsets did change under the kept clock: 17:00 PST is 01:00Z, 17:00 PDT 00:00Z.
  const pdt = addBusinessDays(at("2026-03-06T01:00:00Z"), 3, ANGELES, MONDAY_TO_FRIDAY);
  assert.equal(iso(pdt), "2026-03-11T00:00:00.000Z");
  const nzst = addBusinessDays(at("2026-09-24T05:00:00Z"), 3, AUCKLAND, MONDAY_TO_FRIDAY);
  assert.equal(iso(nzst), "2026-09-29T04:00:00.000Z");

  // 02:30 on the Sunday of a spring-forward does not exist: it lands at 03:30, both sides of UTC.
  assert.equal(iso(instantAt("2026-03-08", "02:30", ANGELES)), "2026-03-08T10:30:00.000Z");
  assert.equal(iso(instantAt("2026-09-27", "02:30", AUCKLAND)), "2026-09-26T14:30:00.000Z");
  assert.equal(later("Sat 2026-03-07 02:30", 1, ANGELES, EVERY_DAY), "Sun 2026-03-08 03:30");
  assert.equal(later("Sat 2026-09-26 02:30", 1, AUCKLAND, EVERY_DAY), "Sun 2026-09-27 03:30");
  const sunday = { start: "02:30", end: "05:00", days: [7] };
  const opens = nextWindowAt(local("Sat 2026-03-07 12:00", ANGELES), ANGELES, sunday);
  assert.equal(reads(opens, ANGELES), "Sun 2026-03-08 03:30");
  // A skipped midnight: the quota day starts at its first instant, 01:00, after the instant asked.
  const santiago = nextQuotaDayAt(at("2026-09-06T03:30:00Z"), "America/Santiago");
  assert.equal(reads(santiago, "America/Santiago"), "Sun 2026-09-06 01:00");
  // A time a fall-back repeats is the earlier of its two instants (PDT, NZDT).
  assert.equal(iso(instantAt("2026-11-01", "01:30", ANGELES)), "2026-11-01T08:30:00.000Z");
  assert.equal(iso(instantAt("2026-04-05", "02:30", AUCKLAND)), "2026-04-04T13:30:00.000Z");
  // The day after a change starts at the new offset.
  assert.equal(quotaDay(at("2026-03-08T07:59:59Z"), ANGELES), "2026-03-07");
  assert.equal(
    iso(nextQuotaDayAt(at("2026-03-08T19:00:00Z"), ANGELES)),
    "2026-03-09T07:00:00.000Z",
  );
});

test("random times stay in [from, to) at least the gap apart; the same seed gives the same times; a short window answers as many as fit, an empty or reversed one none", () => {
  const from = at("2026-06-15T03:30:00Z"); // Monday 09:00 in Kolkata
  const to = at("2026-06-15T12:30:00Z"); // 18:00
  const draw = (seed: string, count: number, minGapMs: number, window = { from, to }) => {
    const generator = synthetic(seed);
    const random = () => generator.int(RANGE) / RANGE;
    return randomTimesInWindow({ ...window, count, minGapMs, random });
  };
  const times = draw("a", 12, 20 * MINUTE_MS);
  assert.equal(times.length, 12);
  times.forEach((time, i) => {
    assert.ok(from <= time && time < to, `time ${i} inside`);
    const previous = times[i - 1];
    if (previous !== undefined) assert.ok(time.getTime() - previous.getTime() >= 20 * MINUTE_MS);
  });
  assert.deepEqual(draw("a", 12, 20 * MINUTE_MS).map(iso), times.map(iso));
  assert.notDeepEqual(draw("b", 12, 20 * MINUTE_MS).map(iso), times.map(iso));

  // Ten minutes hold three times four minutes apart, not five: at the earliest 0, 4 and 8 minutes
  // in, at the latest the last one millisecond before the end.
  const short = { from, to: at("2026-06-15T03:40:00Z") };
  assert.equal(draw("a", 5, 4 * MINUTE_MS, short).length, 3);
  const fixed = (value: number) =>
    randomTimesInWindow({ ...short, count: 5, minGapMs: 4 * MINUTE_MS, random: () => value })
      .map(iso)
      .join(" ");
  assert.equal(
    fixed(0),
    "2026-06-15T03:30:00.000Z 2026-06-15T03:34:00.000Z 2026-06-15T03:38:00.000Z",
  );
  assert.equal(
    fixed(JUST_BELOW_ONE),
    "2026-06-15T03:31:59.999Z 2026-06-15T03:35:59.999Z 2026-06-15T03:39:59.999Z",
  );
  assert.deepEqual(draw("a", 3, MINUTE_MS, { from, to: from }), []);
  assert.deepEqual(draw("a", 3, MINUTE_MS, { from: to, to: from }), []);
  assert.deepEqual(draw("a", 0, MINUTE_MS), []);

  throwsCode(() => draw("a", 1.5, MINUTE_MS), INVALID);
  throwsCode(() => draw("a", -1, MINUTE_MS), INVALID);
  throwsCode(() => draw("a", 3, -1), INVALID);
  throwsCode(() => draw("a", 3, MINUTE_MS, { from: at("not a date"), to }), INVALID);
});

// linkedin's tests/quota-window.test.ts, its cases unchanged, against the moved functions.
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

test("every helper comes from the package's entry; linkedin's WorkingHours fits the hours; days without a weekday and a bad n are refused", () => {
  const helpers = [addBusinessDays, instantAt, isWindowOpen, nextQuotaDayAt, nextWindowAt];
  for (const helper of [...helpers, quotaDay, randomTimesInWindow]) {
    assert.equal(typeof helper, "function");
  }
  assert.deepEqual(MONDAY_TO_FRIDAY, [1, 2, 3, 4, 5]);
  assert.ok(Object.isFrozen(MONDAY_TO_FRIDAY));

  // linkedin's WorkingHours, as core/modules/linkedin/domain/working-hours.ts declares it.
  type WorkingHours = {
    readonly start: string;
    readonly end: string;
    readonly days: readonly number[];
  };
  const workingHours: WorkingHours = { start: "08:30", end: "18:00", days: [1, 2, 3, 4, 5] };
  const monday = at("2026-06-15T03:00:00Z"); // 08:30 in Kolkata
  assert.equal(isWindowOpen(monday, KOLKATA, workingHours), true);
  assert.equal(iso(nextWindowAt(monday, KOLKATA, workingHours)), "2026-06-16T03:00:00.000Z");

  throwsCode(() => addBusinessDays(monday, -1, KOLKATA, MONDAY_TO_FRIDAY), INVALID);
  throwsCode(() => addBusinessDays(monday, 1.5, KOLKATA, MONDAY_TO_FRIDAY), INVALID);
  throwsCode(() => addBusinessDays(monday, Number.POSITIVE_INFINITY, KOLKATA, EVERY_DAY), INVALID);
  throwsCode(() => addBusinessDays(monday, 1, KOLKATA, [0, 8]), INVALID);
  const noDay = { ...workingHours, days: [] };
  throwsCode(() => nextWindowAt(monday, KOLKATA, noDay), INVALID);
});
