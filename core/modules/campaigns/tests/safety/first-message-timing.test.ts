// The safety case of the first message's timing (beta-p4-050; docs/security.md; RB-11.2.4: no message
// within 10 minutes of an acceptance; beta, "rules we keep": working hours cannot be exceeded by
// anyone, including us), run by `pnpm -F campaigns test:safety` and not by `test`. Over seeded
// detection times across two years in three zones, so they fall on both sides of every
// daylight-saving change, and seeded working hours, Saturday or Sunday among the days at times: the
// first message is never due under 10 minutes after the detection, nor outside the account's hours
// or days, nor on a Saturday or Sunday in its zone; inside the window it is due 1 to 3 hours after
// the detection; an account whose days hold no weekday gets no due time at all. Then, through the
// subscriber's body on the worktree's database, message_1's due_at holds the same, the connection
// request keeps its status, and a second acceptance, earlier or later, moves nothing. Each zone's
// clock is read here with Intl alone, and the bounds are written here, not read from the code they
// check.
import assert from "node:assert/strict";
import test from "node:test";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { createConnectedAccount, useLinkedinClient } from "@whytide/linkedin/testing";
import { type Synthetic, synthetic } from "@whytide/platform";
import { firstMessageDueAt, recordAcceptance } from "../../domain/acceptance.ts";
import { useRandom } from "../../testing/index.ts";
import { APPROVER, fixture } from "../fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));

const ZONES = ["Pacific/Auckland", "America/Los_Angeles", "Asia/Kolkata"];
const SEEDS = 400;
const DB_SEEDS = 4;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** RB-11.2.4: never within 10 minutes of the acceptance; the icebreaker 1 to 3 hours after it. */
const LEAST_AFTER_MS = 10 * MINUTE_MS;
const DRAW_FROM_MS = 1 * HOUR_MS;
const DRAW_TO_MS = 3 * HOUR_MS;
/** Two years of detections, so they fall on both sides of every daylight-saving change. */
const FIRST_MS = Date.parse("2026-01-01T00:00:00Z");
const SPAN_MS = 730 * DAY_MS;
const LAST_MINUTE = 23 * 60 + 59;
/** synthetic's sequence is 32-bit numbers over 2^32, so this reads it back exactly. */
const RANGE = 2 ** 32;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type Hours = { start: string; end: string; days: number[] };

const clocks = new Map<string, Intl.DateTimeFormat>();
/** The zone's clock at the instant, from Intl alone: `{ weekday: "Mon", date, time: "09:00" }`. */
function clock(at: Date, timeZone: string): { weekday: string; date: string; time: string } {
  let format = clocks.get(timeZone);
  if (format === undefined) {
    const options = { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit" } as const;
    const date = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
    format = new Intl.DateTimeFormat("en-US", { ...options, ...date, hourCycle: "h23" });
    clocks.set(timeZone, format);
  }
  const parts = format.formatToParts(at);
  const part = (type: string) => parts.find((each) => each.type === type)?.value ?? "";
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  return { weekday: part("weekday"), date, time: `${part("hour")}:${part("minute")}` };
}

/** Whether the account may act at the instant: a weekday of its days, inside its hours. */
function open(at: Date, timeZone: string, hours: Hours): boolean {
  const { weekday, time } = clock(at, timeZone);
  const day = WEEK.indexOf(weekday) + 1;
  return (
    WEEKDAYS.includes(weekday) &&
    hours.days.includes(day) &&
    hours.start <= time &&
    time < hours.end
  );
}

const hhmm = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** Hours from 05:00 at the earliest, a quarter of an hour to twelve hours long; any days. */
function hoursOf(s: Synthetic): Hours {
  const startMinute = 5 * 60 + s.int(6 * 60);
  const endMinute = Math.min(startMinute + 15 + s.int(12 * 60), LAST_MINUTE);
  const days = [1, 2, 3, 4, 5, 6, 7].filter((day) => s.int(day <= 5 ? 6 : 3) !== 0);
  return { start: hhmm(startMinute), end: hhmm(endMinute), days };
}

const hasWeekday = (hours: Hours) => hours.days.some((day) => day <= 5);

/**
 * The bounds on a due time: at least 10 minutes after the detection, on a weekday of the account's
 * days inside its hours, in its zone; and 1 to 3 hours after the detection when that whole stretch
 * lies inside one day's window.
 */
function checkDue(due: Date | null, detectedAt: Date, zone: string, hours: Hours, what: string) {
  if (!hasWeekday(hours)) {
    assert.equal(due, null, `${what}: a due time with no weekday among the days`);
    return;
  }
  assert.ok(due !== null, `${what}: no due time`);
  const where = `${what}: due ${due.toISOString()}`;
  const after = due.getTime() - detectedAt.getTime();
  assert.ok(after >= LEAST_AFTER_MS, `${where}, ${after} ms after the detection`);
  const local = clock(due, zone);
  assert.ok(WEEKDAYS.includes(local.weekday), `${where}, a ${local.weekday}`);
  assert.ok(open(due, zone, hours), `${where}, outside the account's hours or days`);
  const from = new Date(detectedAt.getTime() + DRAW_FROM_MS);
  const to = new Date(detectedAt.getTime() + DRAW_TO_MS - MINUTE_MS);
  const oneDay = clock(from, zone).date === clock(to, zone).date;
  if (oneDay && open(from, zone, hours) && open(to, zone, hours)) {
    assert.ok(after >= DRAW_FROM_MS && after < DRAW_TO_MS, `${where}, ${after} ms in the window`);
  }
}

test("over seeded detection times and working hours in three zones: never under 10 minutes after the detection, never outside the hours or the days, never on a Saturday or Sunday in the zone, 1 to 3 hours after it inside the window, and no due time without a weekday", () => {
  for (const zone of ZONES) {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const s = synthetic(`campaigns-first-message:${zone}:${seed}`);
      const hours = hoursOf(s);
      const detectedAt = new Date(FIRST_MS + s.int(SPAN_MS));
      const source = () => s.int(RANGE) / RANGE;
      const account = { timeZone: zone, workingHours: hours };
      const due = firstMessageDueAt(detectedAt, account, source);
      const what = `${zone}, seed ${seed}, ${JSON.stringify(hours)}, detected ${detectedAt.toISOString()}`;
      checkDue(due, detectedAt, zone, hours, what);
    }
  }
});

test("through the subscriber's body, seeded acceptances in three zones: message_1 due within the bounds and as the draw answers, the connection request's status kept; a second acceptance, earlier or later, moves nothing", async () => {
  for (const zone of ZONES) {
    for (let seed = 1; seed <= DB_SEEDS; seed += 1) {
      const s = synthetic(`campaigns-first-message-db:${zone}:${seed}`);
      const tag = `${ZONES.indexOf(zone)}_${seed}`;
      const hours = hoursOf(s);
      const { run, enrolledLead, moveStep, app } = fixture(`wsp_first_message_${tag}`);
      const workingHours = hours;
      const { id: senderAccountId } = await createConnectedAccount(`wsp_first_message_${tag}`, {
        ...{ ownerUserId: APPROVER, timeZone: zone, workingHours },
      });
      const { personId, steps } = await enrolledLead(`first-message-${tag}`);
      const status = s.pick(["succeeded", "executing"] as const);
      await moveStep(steps.connect, status);
      const detectedAt = new Date(FIRST_MS + s.int(SPAN_MS));
      const draw = s.int(RANGE) / RANGE;
      const what = `${zone}, seed ${seed}, ${JSON.stringify(hours)}, detected ${detectedAt.toISOString()}`;

      useRandom(() => draw);
      try {
        await run((tx) => recordAcceptance(tx, { senderAccountId, personId, detectedAt }));
      } finally {
        useRandom(undefined);
      }
      const stepOf = (id: string) => app().stepExecution.findUniqueOrThrow({ where: { id } });
      const connect = await stepOf(steps.connect);
      assert.deepEqual([connect.status, connect.acceptedAt], [status, detectedAt], what);
      const message = await stepOf(steps.message_1);
      assert.equal(message.status, "planned", what);
      checkDue(message.dueAt, detectedAt, zone, hours, what);
      const account = { timeZone: zone, workingHours: hours };
      assert.deepEqual(
        message.dueAt,
        firstMessageDueAt(detectedAt, account, () => draw),
        what,
      );

      // The daily check's acceptance of the same person, hours before or after: nothing moves.
      const rows = await app().stepExecution.findMany({
        where: { personId },
        orderBy: { id: "asc" },
      });
      const shift = (s.int(2) === 0 ? -1 : 1) * (MINUTE_MS + s.int(DAY_MS));
      const again = new Date(detectedAt.getTime() + shift);
      useRandom(() => s.int(RANGE) / RANGE);
      try {
        const outcome = await run((tx) =>
          recordAcceptance(tx, { senderAccountId, personId, detectedAt: again }),
        );
        assert.equal(outcome, "unchanged", what);
      } finally {
        useRandom(undefined);
      }
      const after = await app().stepExecution.findMany({
        where: { personId },
        orderBy: { id: "asc" },
      });
      assert.deepEqual(after, rows, `${what}: a second acceptance wrote`);
    }
  }
});
