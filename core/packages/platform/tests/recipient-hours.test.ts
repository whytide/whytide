// gamma-p0-070, end to end through the package's entry: the lead's zone from a country and a
// location text, the tables behind it, the window an email goes in (the recipient's business hours
// in Los Angeles, Berlin and Kolkata, or the sender's schedule), its local 08:30 and 18:00 across
// daylight-saving changes, seeded spacing, and each refusal. The zones' clocks are read with Intl
// alone. The safety case is tests/safety/recipient-hours.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import {
  COUNTRY_TIME_ZONES,
  instantAt,
  isAppError,
  isTimeZone,
  isWindowOpen,
  type LocalSchedule,
  nextSpacedTime,
  nextWindowAt,
  RECIPIENT_BUSINESS_HOURS,
  REGION_TIME_ZONES,
  type SpacedTimeInput,
  sendWindowFor,
  synthetic,
  timeZoneOf,
} from "../index.ts";

const ANGELES = "America/Los_Angeles";
const BERLIN = "Europe/Berlin";
const KOLKATA = "Asia/Kolkata";
const JERUSALEM = "Asia/Jerusalem";
const MINUTE_MS = 60_000;
const GAPS = { minGapMs: 4 * MINUTE_MS, maxGapMs: 12 * MINUTE_MS };
const RANGE = 2 ** 32;
const JUST_BELOW_ONE = 1 - Number.EPSILON / 2;
const INVALID = "time_argument_invalid";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const SENDER: LocalSchedule = {
  timeZone: "Europe/London",
  start: "09:00",
  end: "17:30",
  days: [1, 2, 3, 4, 5],
};
/** The countries with no entry: several zones, people split between two, or no people. */
const UNKNOWN = ["AQ", "BR", "BV", "CD", "FM", "HM", "ID", "MX", "RU", "UM"];
/** Codes ICU names that are no country, which contacts' countryOf leaves out too. */
const NOT_COUNTRIES = "AC CP CQ DG EA EU EZ IC QO TA UN XA XB ZZ".split(" ");
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const iso = (date: Date) => date.toISOString();
const sequence = (values: number[]) => () => values.shift() ?? Number.NaN;

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

function refuses(fn: () => unknown, field: string): void {
  assert.throws(
    fn,
    (error: unknown) =>
      isAppError(error) && error.code === INVALID && error.details?.field === field,
    `${INVALID} on ${field}`,
  );
}

test("the lead's zone: a one-zone country answers its zone, the United States, Canada and Australia the region the text names, any other country or none null", () => {
  const cases: [string | null | undefined, string | null | undefined, string | null][] = [
    ["GB", "London, England, United Kingdom", "Europe/London"],
    ["IN", "Bengaluru, Karnataka, India", KOLKATA],
    ["IN", null, KOLKATA],
    ["US", "San Francisco, California", ANGELES],
    ["US", "Boston, MA", "America/New_York"],
    ["AU", "Perth, Western Australia", "Australia/Perth"],
    ["US", "Austin, Texas, United States", "America/Chicago"],
    ["US", "Seattle, Washington, United States", ANGELES],
    // The part nearest the country wins: Washington the city is in the District of Columbia.
    ["US", "Washington, District of Columbia, United States", "America/New_York"],
    ["US", "Washington, D.C.", "America/New_York"],
    ["CA", "Montréal, Québec, Canada", "America/Toronto"],
    ["CA", "St. John's, Newfoundland & Labrador", "America/St_Johns"],
    ["AU", "Sydney, N.S.W.", "Australia/Sydney"],
    // A small part in another zone: the capital's.
    ["ES", "Las Palmas, Canary Islands, Spain", "Europe/Madrid"],
    ["US", "San Francisco Bay Area", null],
    ["US", "United States", null],
    ["US", "", null],
    ["US", null, null],
    ["US", "toString, constructor", null],
    ["BR", "São Paulo, Brazil", null],
    ["MX", "Mexico City, Mexico", null],
    ["RU", null, null],
    ["ID", "Jakarta, Indonesia", null],
    [null, "Boston, MA", null],
    [undefined, undefined, null],
    ["", "London", null],
    ["QQ", "London", null],
    ["__proto__", "constructor", null],
  ];
  for (const [country, locationText, zone] of cases) {
    assert.equal(timeZoneOf({ country, locationText }), zone, `${country} with ${locationText}`);
  }
});

test("every zone in both tables passes isTimeZone, every country key is alpha-2, each region's names find its zone, and only the listed countries are unknown", () => {
  const display = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
  const isCountry = (code: string) => /^[A-Z]{2}$/.test(code) && display.of(code) !== undefined;
  assert.ok(Object.isFrozen(COUNTRY_TIME_ZONES) && Object.isFrozen(REGION_TIME_ZONES));
  for (const [code, zone] of Object.entries(COUNTRY_TIME_ZONES)) {
    assert.ok(isCountry(code), `${code} is an alpha-2 country`);
    assert.ok(isTimeZone(zone), `${code}: ${zone}`);
    assert.equal(timeZoneOf({ country: code }), zone);
  }
  assert.deepEqual(Object.keys(REGION_TIME_ZONES).sort(), ["AU", "CA", "US"]);
  for (const [code, regions] of Object.entries(REGION_TIME_ZONES)) {
    assert.ok(isCountry(code), `${code} is an alpha-2 country`);
    assert.equal(code in COUNTRY_TIME_ZONES, false, `${code} in one table only`);
    for (const { names, zone } of regions) {
      assert.ok(isTimeZone(zone), `${code} ${names[0]}: ${zone}`);
      for (const name of names) {
        const locationText = `Somewhere, ${name}`;
        assert.equal(timeZoneOf({ country: code, locationText }), zone, `${code} ${name}`);
      }
    }
  }
  // Every country ICU names, as contacts' countryOf reads them, is in a table or listed unknown.
  const codes = [...LETTERS]
    .flatMap((first) => [...LETTERS].map((second) => first + second))
    .filter((code) => isCountry(code) && !NOT_COUNTRIES.includes(code))
    .filter((code) => Intl.getCanonicalLocales(`und-${code}`)[0] === `und-${code}`);
  const missing = codes.filter(
    (code) => !(code in COUNTRY_TIME_ZONES || code in REGION_TIME_ZONES),
  );
  assert.deepEqual(missing, UNKNOWN);
  for (const country of UNKNOWN) assert.equal(timeZoneOf({ country, locationText: "A, B" }), null);
});

test("sendWindowFor gives Monday to Friday 08:30 to 18:00 in the recipient's zone when it is known, the sender's schedule when it is not, and says which", () => {
  assert.deepEqual(RECIPIENT_BUSINESS_HOURS, {
    start: "08:30",
    end: "18:00",
    days: [1, 2, 3, 4, 5],
  });
  assert.ok(
    Object.isFrozen(RECIPIENT_BUSINESS_HOURS) && Object.isFrozen(RECIPIENT_BUSINESS_HOURS.days),
  );
  for (const zone of [ANGELES, BERLIN, KOLKATA]) {
    const window = sendWindowFor({ recipientZone: zone, sender: SENDER });
    const schedule = { timeZone: zone, start: "08:30", end: "18:00", days: [1, 2, 3, 4, 5] };
    assert.deepEqual(window, { used: "recipient", schedule });
    const open = (reading: string) => isWindowOpen(local(reading, zone), zone, window.schedule);
    const readings = [
      "Mon 2026-06-15 08:29",
      "Mon 2026-06-15 08:30",
      "Fri 2026-06-19 17:59",
      "Fri 2026-06-19 18:00",
      "Sat 2026-06-20 10:00",
      "Sun 2026-06-21 10:00",
    ];
    assert.deepEqual(readings.map(open), [false, true, true, false, false, false], zone);
    const next = nextWindowAt(local("Fri 2026-06-19 18:00", zone), zone, window.schedule);
    assert.equal(reads(next, zone), "Mon 2026-06-22 08:30");
  }
  // Kolkata is UTC+05:30 all year: its 08:30 is 03:00Z.
  assert.equal(iso(local("Mon 2026-06-15 08:30", KOLKATA)), "2026-06-15T03:00:00.000Z");
  assert.deepEqual(sendWindowFor({ recipientZone: null, sender: SENDER }), {
    used: "sender",
    schedule: SENDER,
  });
  // The lead's zone into the window, as the email module chains them.
  const zoneOf = (country: string, locationText: string) => timeZoneOf({ country, locationText });
  const berlin = sendWindowFor({ recipientZone: zoneOf("DE", "Berlin, Germany"), sender: SENDER });
  assert.deepEqual([berlin.used, berlin.schedule.timeZone], ["recipient", BERLIN]);
  const brazil = sendWindowFor({ recipientZone: zoneOf("BR", "Recife, Brazil"), sender: SENDER });
  assert.deepEqual([brazil.used, brazil.schedule.timeZone], ["sender", "Europe/London"]);
});

test("across a daylight-saving change in the recipient's zone the window keeps its local 08:30 and 18:00", () => {
  // Los Angeles and Berlin change on Sundays, outside the window; Jerusalem on Friday 2026-03-27 at
  // 02:00, on one of its days. The instants show the offsets that changed under the kept clock.
  const changes = [
    [
      ANGELES,
      "Fri 2026-03-06",
      "2026-03-06T16:30:00.000Z",
      "Mon 2026-03-09",
      "2026-03-09T15:30:00.000Z",
    ],
    [
      ANGELES,
      "Fri 2026-10-30",
      "2026-10-30T15:30:00.000Z",
      "Mon 2026-11-02",
      "2026-11-02T16:30:00.000Z",
    ],
    [
      BERLIN,
      "Fri 2026-03-27",
      "2026-03-27T07:30:00.000Z",
      "Mon 2026-03-30",
      "2026-03-30T06:30:00.000Z",
    ],
    [
      BERLIN,
      "Fri 2026-10-23",
      "2026-10-23T06:30:00.000Z",
      "Mon 2026-10-26",
      "2026-10-26T07:30:00.000Z",
    ],
    [
      JERUSALEM,
      "Thu 2026-03-26",
      "2026-03-26T06:30:00.000Z",
      "Fri 2026-03-27",
      "2026-03-27T05:30:00.000Z",
    ],
  ] as const;
  for (const [zone, before, opensBefore, after, opensAfter] of changes) {
    const { schedule } = sendWindowFor({ recipientZone: zone, sender: SENDER });
    for (const [day, opens] of [
      [before, opensBefore],
      [after, opensAfter],
    ]) {
      const start = nextWindowAt(local(`${day} 08:00`, zone), zone, schedule);
      assert.deepEqual([reads(start, zone), iso(start)], [`${day} 08:30`, opens]);
      assert.equal(isWindowOpen(local(`${day} 17:59`, zone), zone, schedule), true, `${day} 17:59`);
      assert.equal(
        isWindowOpen(local(`${day} 18:00`, zone), zone, schedule),
        false,
        `${day} 18:00`,
      );
    }
    // Two minutes before the window closes, the next send opens the day after the change.
    const late = local(`${before} 17:58`, zone);
    const hours = schedule;
    const send = nextSpacedTime({
      after: late,
      ...GAPS,
      timeZone: zone,
      hours,
      random: () => 0.75,
    });
    assert.equal(reads(send, zone), `${after} 08:36`);
  }
});

test("nextSpacedTime with gaps of 4 and 12 minutes answers 4 to 12 minutes after `after` inside the window, within the first 8 minutes of the next window start outside it, never at a weekend; a seed repeats", () => {
  const hours = RECIPIENT_BUSINESS_HOURS;
  const send = (reading: string, random: () => number) =>
    iso(
      nextSpacedTime({ after: local(reading, BERLIN), ...GAPS, timeZone: BERLIN, hours, random }),
    );
  // Tuesday 10:00 in Berlin is 08:00Z: the ends of the source give 4 minutes and just under 12.
  assert.equal(
    send("Tue 2026-06-16 10:00", () => 0),
    "2026-06-16T08:04:00.000Z",
  );
  assert.equal(
    send("Tue 2026-06-16 10:00", () => 0.5),
    "2026-06-16T08:08:00.000Z",
  );
  assert.equal(
    send("Tue 2026-06-16 10:00", () => JUST_BELOW_ONE),
    "2026-06-16T08:11:59.999Z",
  );
  // Friday 17:50: 4 minutes stays inside; 11 minutes 12 seconds falls after 18:00, so the time is
  // Monday 08:30 (06:30Z) plus the second draw of the 8 minutes.
  assert.equal(
    send("Fri 2026-06-19 17:50", () => 0),
    "2026-06-19T15:54:00.000Z",
  );
  assert.equal(send("Fri 2026-06-19 17:50", sequence([0.9, 0.9])), "2026-06-22T06:37:12.000Z");
  assert.equal(send("Sat 2026-06-20 11:00", sequence([0, 0])), "2026-06-22T06:30:00.000Z");
  assert.equal(
    send("Sat 2026-06-20 11:00", sequence([0, JUST_BELOW_ONE])),
    "2026-06-22T06:37:59.999Z",
  );
  // Before the window opens the same morning: 08:26 is outside, so 08:30 plus 2 minutes.
  assert.equal(send("Mon 2026-06-22 08:20", sequence([0.25, 0.25])), "2026-06-22T06:32:00.000Z");
  // A gap of exactly 5 minutes, both ends the same.
  const exact = { minGapMs: 5 * MINUTE_MS, maxGapMs: 5 * MINUTE_MS };
  const at = local("Tue 2026-06-16 10:00", BERLIN);
  const five = nextSpacedTime({ after: at, ...exact, timeZone: BERLIN, hours, random: () => 0.5 });
  assert.equal(iso(five), "2026-06-16T08:05:00.000Z");

  // A seeded run of sends from Wednesday to the next week, each spaced from the one before.
  const run = (seed: string, zone: string) => {
    const generator = synthetic(seed);
    const random = () => generator.int(RANGE) / RANGE;
    const sends = [local("Wed 2026-06-17 08:30", zone)];
    for (let i = 0; i < 300; i++) {
      const after = sends.at(-1) as Date;
      sends.push(nextSpacedTime({ after, ...GAPS, timeZone: zone, hours, random }));
    }
    return sends;
  };
  for (const zone of [ANGELES, BERLIN, KOLKATA]) {
    const sends = run("a", zone);
    let windowStarts = 0;
    for (let i = 1; i < sends.length; i++) {
      const [previous, time] = [sends[i - 1] as Date, sends[i] as Date];
      const gap = time.getTime() - previous.getTime();
      const reading = reads(time, zone);
      assert.ok(WEEKDAYS.includes(reading.slice(0, 3)), `send ${i} on ${reading}`);
      if (gap < GAPS.maxGapMs) {
        assert.ok(gap >= GAPS.minGapMs, `send ${i}: ${gap} ms after the one before`);
        assert.ok("08:30" <= reading.slice(15) && reading.slice(15) < "18:00", `send ${i}`);
      } else {
        // Outside the window: within the first 8 minutes of the next window start.
        assert.ok("08:30" <= reading.slice(15) && reading.slice(15) < "08:38", `send ${i}`);
        windowStarts++;
      }
    }
    assert.ok(windowStarts >= 3, `${zone}: the run crossed nights and a weekend`);
    assert.deepEqual(run("a", zone).map(iso), sends.map(iso));
    assert.notDeepEqual(run("b", zone).map(iso), sends.map(iso));
  }
});

test("a bad argument throws time_argument_invalid with its field, and no time is placed", () => {
  const after = local("Tue 2026-06-16 10:00", BERLIN);
  const hours = RECIPIENT_BUSINESS_HOURS;
  const good: SpacedTimeInput = { after, ...GAPS, timeZone: BERLIN, hours, random: () => 0.5 };
  const refused: [Partial<SpacedTimeInput>, string][] = [
    [{ minGapMs: 13 * MINUTE_MS }, "minGapMs"],
    [{ minGapMs: -1 }, "minGapMs"],
    [{ minGapMs: 1.5 }, "minGapMs"],
    [{ maxGapMs: -1 }, "maxGapMs"],
    [{ maxGapMs: Number.POSITIVE_INFINITY }, "maxGapMs"],
    [{ maxGapMs: Number.NaN }, "maxGapMs"],
    [{ after: new Date(Number.NaN) }, "after"],
    [{ timeZone: "Mars/Olympus_Mons" }, "timeZone"],
    [{ timeZone: "" }, "timeZone"],
    [{ hours: { ...hours, start: "8:30" } }, "hours"],
    [{ hours: { ...hours, end: "08:30" } }, "hours"],
    [{ hours: { ...hours, days: [] } }, "hours"],
    [{ hours: { ...hours, days: [0, 8] } }, "hours"],
    [{ random: () => 1 }, "random"],
    [{ random: () => -0.1 }, "random"],
    [{ random: () => Number.NaN }, "random"],
  ];
  for (const [change, field] of refused)
    refuses(() => nextSpacedTime({ ...good, ...change }), field);
  // The second draw, which places the next window's time, is checked as the first is.
  const friday = { ...good, after: local("Fri 2026-06-19 17:59", BERLIN) };
  refuses(() => nextSpacedTime({ ...friday, random: sequence([0.9, 1]) }), "random");

  refuses(() => sendWindowFor({ recipientZone: "Not/A_Zone", sender: SENDER }), "recipientZone");
  refuses(() => sendWindowFor({ recipientZone: "", sender: SENDER }), "recipientZone");
  const badZone = { ...SENDER, timeZone: "Not/A_Zone" };
  refuses(() => sendWindowFor({ recipientZone: BERLIN, sender: badZone }), "sender");
  refuses(
    () => sendWindowFor({ recipientZone: null, sender: { ...SENDER, start: "18:00" } }),
    "sender",
  );
  refuses(() => sendWindowFor({ recipientZone: null, sender: { ...SENDER, days: [] } }), "sender");
});
