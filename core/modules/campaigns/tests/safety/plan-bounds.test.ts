// The safety case of the daily plan (beta-p4-010; docs/security.md; beta, "rules we keep": hard caps
// and working hours cannot be exceeded by anyone, including us), run by `pnpm -F campaigns
// test:safety` and not by `test`, on the worktree's database in this file's schema, through
// planAccount with linkedin's remainingToday and contacts' touches. Over seeded random accounts in
// three zones (working hours with Saturday or Sunday among the days at times; the day's limits drawn,
// partly used, and reads made past their allowance at times, so the three types together pass the
// actions left), persons touched today or not, with a random priority or none (gamma-p5-070,
// qualification's setLeadPriority), and steps due or not, placed earlier or not, kept from an
// earlier run of the day, in flight or sent: two runs, with the sender's sends between them. No
// run places more of a type, or of all three, than remainingToday leaves; no time leaves the
// window or falls on a Saturday or Sunday; a person gets one step a day at most and none on a day
// already touched; no two times, across the runs and the sends, are closer than the gap, nor a new
// one to the last send; nothing but a scheduled step's time is ever written; a kept step keeps its
// time, and loses it only past the room the kept steps alone take, the latest first, never for a
// candidate, whatever the priorities. Then an account that may not send, remainingToday answering
// windowEnd null, gets nothing, its lead Hot (decisions.md, Finding 56). Each zone's clock is read
// here with Intl alone.
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { lastTouchAt, recordTouch, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { type Prisma, type TenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { type RemainingToday, remainingToday } from "@whytide/linkedin";
import {
  createConnectedAccount,
  openSending,
  useLinkedinClient,
  useClock as useLinkedinClock,
  useRandom as useLinkedinRandom,
} from "@whytide/linkedin/testing";
import { instantAt, newId, quotaDay, servicePrincipal, synthetic } from "@whytide/platform";
import { setLeadPriority } from "@whytide/qualification/testing";
import { planAccount } from "../../domain/plan/account.ts";
import { MIN_ACTION_GAP_MS } from "../../domain/plan/constants.ts";
import { linkedinActionType } from "../../domain/steps/actions.ts";
import { ids } from "../../ids.ts";
import { useClock, useRandom } from "../../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
// Sending open, as the operator opens it (beta-p1-040): on a fresh database it is closed, and
// remainingToday would leave the plan nothing to place.
beforeEach(() => openSending());
const app = () => asRole("app");
const ZONES = ["Pacific/Auckland", "America/Los_Angeles", "Asia/Kolkata"];
const SEEDS = 20;
/** Two years of dates, so the runs fall on both sides of every daylight-saving change. */
const FIRST_MS = Date.parse("2026-01-01T00:00:00Z");
const SPAN_DAYS = 730;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const LAST_MINUTE = 23 * 60 + 59;
/** linkedin's 200 actions a day, and the actions a tight day leaves at most. */
const ACTIONS_PER_DAY = 200;
const TIGHT_ACTIONS = 8;
/** synthetic's sequence is 32-bit numbers over 2^32, so this reads it back exactly. */
const RANGE = 2 ** 32;
const ACTIONS = ["invite", "message", "withdraw"] as const;
const CAPACITY_OF = { invite: "invites", message: "messages", withdraw: "withdrawals" } as const;
const COMMITTED = {
  invite: "invitesCommitted",
  message: "messagesCommitted",
  withdraw: "withdrawalsCommitted",
} as const;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const TEMPLATE = { templateId: "linkedin_default", templateVersion: 1 };
/** A lead's priority, 0 to 100 (qualification's), one in NO_PRIORITY_ONE_IN persons with none. */
const PRIORITY_MAX = 100;
const NO_PRIORITY_ONE_IN = 4;
/** One in KEPT_ONE_IN persons' first step placed earlier today, ahead of the first run. */
const KEPT_ONE_IN = 4;

type Hours = { start: string; end: string; days: number[] };
type Row = Awaited<ReturnType<typeof stepsOf>>[number];
type StepFields = Partial<Prisma.StepExecutionCreateManyInput>;

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

const hhmm = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const stepsOf = (workspaceId: string) =>
  app().stepExecution.findMany({ where: { workspaceId }, orderBy: { id: "asc" } });
const time = (date: Date | null | undefined) => date?.getTime() ?? null;
/** How far the step's time is behind `at`; negative ahead of it. */
const behindOf = (row: Row, at: Date) => at.getTime() - (time(row.scheduledFor) ?? 0);
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Both modules' clocks at `at`: the plan's, and the one remainingToday reads. */
function setClocks(at: Date): void {
  useClock(() => at);
  useLinkedinClock(() => at);
}

/** A person of the workspace through contacts' command, in the caller's run: its id. */
async function personOf(linkedinUrl: string): Promise<string> {
  const profile = { linkedinUrl, firstName: "Noor" };
  return (await upsertPersonFromSource({ source: "import", provider: "csv", profile })).person.id;
}

/**
 * What one run may have done, checked against the rows before and after it: only a scheduled step's
 * time and quota day written; the limits, the window and its weekdays, the person's one step a day,
 * none for a person touched today, no stale time left behind. Returns the times this run placed.
 */
function checkRun(run: {
  readonly zone: string;
  readonly hours: Hours;
  readonly at: Date;
  readonly left: RemainingToday;
  readonly before: readonly Row[];
  readonly after: readonly Row[];
  readonly touched: ReadonlySet<string>;
  readonly what: string;
}): Map<string, Date> {
  const { zone, hours, at, left, what } = run;
  const today = quotaDay(at, zone);
  const local = clock(at, zone);
  const open =
    WEEKDAYS.includes(local.weekday) &&
    hours.days.includes(WEEKDAYS.indexOf(local.weekday) + 1) &&
    hours.start <= local.time &&
    local.time < hours.end;
  const placed = new Map<string, Date>();
  if (!open || left.windowEnd === null) {
    // A Saturday or Sunday, the window closed, or none left: the run writes nothing at all.
    assert.deepEqual(run.after, run.before, `${what}: a run with the window closed wrote`);
    return placed;
  }
  checkKept(run);
  const before = new Map(run.before.map((row) => [row.id, row]));
  for (const row of run.after) {
    const was = before.get(row.id);
    assert.ok(was, `${what}: no step appears`);
    const { scheduledFor, quotaDay: day, updatedAt: _now, ...rest } = row;
    const { scheduledFor: wasFor, quotaDay: wasDay, updatedAt: _then, ...wasRest } = was;
    assert.deepEqual(rest, wasRest, `${what}: only a time and a quota day are written`);
    if (was.status !== "scheduled") {
      assert.deepEqual(row, was, `${what}: a step ${was.status} is written`);
      continue;
    }
    if (scheduledFor === null || time(scheduledFor) === time(wasFor)) continue;
    placed.set(row.id, scheduledFor);
    const where = `${what}: ${row.id} at ${scheduledFor.toISOString()}`;
    assert.ok(row.dueAt !== null && row.dueAt <= at, `${where}: not due`);
    assert.ok(at <= scheduledFor, `${where}: before the run`);
    assert.ok(left.windowEnd !== null && scheduledFor < left.windowEnd, `${where}: past the end`);
    const placedAt = clock(scheduledFor, zone);
    assert.ok(WEEKDAYS.includes(placedAt.weekday), `${where}: a ${placedAt.weekday}`);
    assert.ok(hours.start <= placedAt.time && placedAt.time < hours.end, `${where}: outside hours`);
    assert.equal(day, today, `${where}: the quota day`);
    assert.ok(!run.touched.has(row.personId), `${where}: a person touched today`);
  }
  const placedToday = run.after.filter(
    (row) => row.status === "scheduled" && row.scheduledFor !== null && row.quotaDay === today,
  );
  for (const action of ACTIONS) {
    const count = placedToday.filter((row) => row.actionType === action).length;
    assert.ok(count <= left[CAPACITY_OF[action]], `${what}: ${count} ${action} steps`);
  }
  assert.ok(placedToday.length <= left.actions, `${what}: ${placedToday.length} actions`);
  const sentToday = run.after.filter(
    (row) => row.executedAt !== null && quotaDay(row.executedAt, zone) === today,
  );
  const perPerson = new Map<string, number>();
  for (const row of [...placedToday, ...sentToday]) {
    perPerson.set(row.personId, (perPerson.get(row.personId) ?? 0) + 1);
  }
  for (const [personId, count] of perPerson) {
    assert.ok(count <= 1, `${what}: ${count} steps of ${personId} on ${today}`);
  }
  for (const row of run.after.filter((each) => each.status === "scheduled")) {
    if (row.scheduledFor === null) continue;
    assert.equal(row.quotaDay, today, `${what}: ${row.id} left on another day`);
    const behind = at.getTime() - row.scheduledFor.getTime();
    assert.ok(behind < MIN_ACTION_GAP_MS, `${what}: ${row.id} left ${behind} ms behind`);
  }
  return placed;
}

/**
 * The steps kept at the run's start, placed on its quota day ahead of it or less than a gap
 * behind: each keeps its time while the kept steps before it, earliest first, leave its type and
 * the actions room, else loses it (null), whatever the candidates and their persons' priorities. A
 * candidate never takes a kept step's time or its room.
 */
function checkKept(run: {
  readonly zone: string;
  readonly at: Date;
  readonly left: RemainingToday;
  readonly before: readonly Row[];
  readonly after: readonly Row[];
  readonly what: string;
}): void {
  const { at, left, what } = run;
  const today = quotaDay(at, run.zone);
  const after = new Map(run.after.map((row) => [row.id, row]));
  const kept = run.before
    .filter((row) => row.status === "scheduled" && row.scheduledFor !== null)
    .filter((row) => row.quotaDay === today && behindOf(row, at) < MIN_ACTION_GAP_MS)
    .sort((a, b) => (time(a.scheduledFor) ?? 0) - (time(b.scheduledFor) ?? 0) || byId(a.id, b.id));
  const used = { invites: 0, messages: 0, withdrawals: 0, actions: 0 };
  for (const row of kept) {
    const type = CAPACITY_OF[linkedinActionType(row)];
    const now = after.get(row.id)?.scheduledFor ?? null;
    const where = `${what}: the kept ${row.id} at ${row.scheduledFor?.toISOString()}`;
    if (used[type] < left[type] && used.actions < left.actions) {
      used[type] += 1;
      used.actions += 1;
      assert.equal(time(now), time(row.scheduledFor), `${where} lost or moved within the room`);
    } else {
      assert.equal(now, null, `${where} kept past the room`);
    }
  }
}

/** Every two times of the account, placed and kept across the runs and sent, at least a gap apart. */
function checkGaps(times: readonly Date[], what: string): void {
  const sorted = times.map((at) => at.getTime()).sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = (sorted[i] ?? 0) - (sorted[i - 1] ?? 0);
    assert.ok(gap >= MIN_ACTION_GAP_MS, `${what}: two times ${gap} ms apart`);
  }
}

async function scenario(zone: string, seed: number): Promise<void> {
  const s = synthetic(`campaigns-plan-bounds:${zone}:${seed}`);
  // gamma-p5-070's draws, the priorities and the kept steps, apart: beta's setup draws stay as
  // they were.
  const p = synthetic(`campaigns-plan-bounds:priorities:${zone}:${seed}`);
  const source = () => s.int(RANGE) / RANGE;
  useRandom(source);
  useLinkedinRandom(source);
  const tag = `${ZONES.indexOf(zone)}_${seed}`;
  const workspaceId = `wsp_bounds_${tag}`;
  const principal = servicePrincipal("plan_bounds");
  const run = <T>(fn: (tx: TenantClient) => Promise<T>) =>
    withTenant({ workspaceId, principal }, fn, { client: app() });

  // The account: hours from 06:00 to 23:59 at most, Saturday or Sunday among the days at times.
  const startMinute = 6 * 60 + s.int(5 * 60);
  const endMinute = Math.min(startMinute + 2 * 60 + s.int(10 * 60), LAST_MINUTE);
  const weekend = [...(s.int(2) === 0 ? [6] : []), ...(s.int(3) === 0 ? [7] : [])];
  const days = [1, 2, 3, 4, 5, ...weekend];
  const hours = { start: hhmm(startMinute), end: hhmm(endMinute), days };
  const { id: accountId } = await createConnectedAccount(workspaceId, {
    timeZone: zone,
    workingHours: hours,
  });
  const targets = { inviteTarget: 5 + s.int(11), messageTarget: 10 + s.int(31) };
  await app().senderAccount.update({ where: { id: accountId }, data: targets });

  // The first run: a random date, at a local time from an hour before the window to an hour after.
  const date = new Date(FIRST_MS + s.int(SPAN_DAYS) * DAY_MS).toISOString().slice(0, 10);
  const span = endMinute - startMinute + 2 * 60;
  const minute = Math.max(0, Math.min(startMinute - 60 + s.int(span), LAST_MINUTE));
  const first = instantAt(date, hhmm(minute), zone);
  setClocks(first);
  const today = quotaDay(first, zone);
  const midnight = instantAt(today, "00:00", zone);

  // The day's row with its draw, then part of it used; on a third of the days, reads made past their
  // allowance leave fewer actions of the 200 than the three types together, 8 at most.
  await run(() => remainingToday(accountId));
  const sends = { invitesCommitted: s.int(8), messagesCommitted: s.int(20) };
  const withdrawalsCommitted = s.int(6);
  const sent = sends.invitesCommitted + sends.messagesCommitted + withdrawalsCommitted;
  const reads = s.int(3) === 0 ? ACTIONS_PER_DAY - sent - s.int(TIGHT_ACTIONS + 1) : s.int(40);
  await app().senderQuotaUsage.updateMany({
    where: { senderAccountId: accountId },
    data: { ...sends, withdrawalsCommitted, readsCommitted: reads },
  });

  // The persons, touched today before the run, yesterday or never; the last one sent to, at times.
  const count = 3 + s.int(8);
  const lastSent = s.int(2) === 0;
  const sentAt = new Date(first.getTime() - s.int(2 * MIN_ACTION_GAP_MS));
  const personIds = await run(async () => {
    const made: string[] = [];
    for (let index = 0; index <= count; index += 1) {
      const personId = await personOf(`https://linkedin.com/in/plan-bounds-${tag}-${index}`);
      made.push(personId);
      const touch = s.int(5);
      if (index === count) {
        if (lastSent) await recordTouch(personId, sentAt);
      } else if (touch === 0 && first > midnight) {
        const span = first.getTime() - midnight.getTime();
        await recordTouch(personId, new Date(midnight.getTime() + s.int(span)));
      } else if (touch === 1) {
        await recordTouch(personId, new Date(midnight.getTime() - 1 - s.int(DAY_MS / 2)));
      }
    }
    return made;
  });
  // Their priorities, Hot, Warm or Cool, or none: one in NO_PRIORITY_ONE_IN has no intent row.
  await run(async () => {
    for (const personId of personIds) {
      if (p.int(NO_PRIORITY_ONE_IN) !== 0) await setLeadPriority(personId, p.int(PRIORITY_MAX + 1));
    }
  });
  const enrollmentIds = personIds.map(() => newId(ids.enrollment));
  await app().enrollment.createMany({
    data: personIds.map((personId, index) => ({
      ...{ id: enrollmentIds[index] as string, workspaceId, personId, ...TEMPLATE },
      ...{ senderAccountId: accountId, status: "active" as const },
      ...{ sourceEventId: newId("obx"), startedAt: midnight },
    })),
  });

  // Their steps: due or not, placed earlier today or yesterday or not, or kept from an earlier run
  // of today (two gaps apart, ahead of the run, a person's first step only); in flight; the last
  // send.
  const rows: Prisma.StepExecutionCreateManyInput[] = [];
  const kept = new Map<string, Date>();
  const step = (index: number, key: string, fields: StepFields) => {
    const personId = personIds[index] as string;
    const id = newId(ids.step_execution);
    rows.push({
      ...{ id, workspaceId, personId, ...TEMPLATE },
      ...{ enrollmentId: enrollmentIds[index] as string, senderAccountId: accountId },
      ...{ stepKey: key, position: 1 + s.int(4), actionType: s.pick(ACTIONS) },
      ...{ stepTemplateHash: key, idempotencyKey: `${personId}:${key}`, ...fields },
    });
    return id;
  };
  for (let index = 0; index < count; index += 1) {
    if (s.int(10) === 0) {
      // In flight, claimed a moment ago: the sender's alone.
      const claimed = new Date(first.getTime() - s.int(MIN_ACTION_GAP_MS));
      const fields = { status: "executing", attempt: 1, dueAt: midnight } as const;
      step(index, "s0", { ...fields, scheduledFor: claimed, quotaDay: quotaDay(claimed, zone) });
      continue;
    }
    for (let key = 0; key < 1 + s.int(2); key += 1) {
      const ahead = s.int(5) === 0;
      const due = ahead
        ? first.getTime() + 1 + s.int(3 * HOUR_MS)
        : first.getTime() - s.int(3 * DAY_MS);
      const fields: StepFields = { status: "scheduled", dueAt: new Date(due) };
      if (!ahead && s.int(5) === 0) {
        // Placed earlier today, or yesterday, more than a gap ago, and never sent.
        const back = MIN_ACTION_GAP_MS + s.int(3 * HOUR_MS) + (s.int(2) === 0 ? DAY_MS : 0);
        const at = new Date(first.getTime() - back);
        Object.assign(fields, { scheduledFor: at, quotaDay: quotaDay(at, zone) });
      }
      const keep = !ahead && key === 0 && p.int(KEPT_ONE_IN) === 0;
      const keptAt = new Date(first.getTime() + (1 + 2 * kept.size) * MIN_ACTION_GAP_MS);
      if (keep) Object.assign(fields, { scheduledFor: keptAt, quotaDay: quotaDay(keptAt, zone) });
      const id = step(index, `s${key}`, fields);
      if (keep) kept.set(id, keptAt);
    }
  }
  if (lastSent) {
    // The account's last send, less than two gaps ago: the first new time waits a gap after it.
    const fields = {
      status: "succeeded",
      attempt: 1,
      dueAt: midnight,
      executedAt: sentAt,
    } as const;
    step(count, "s0", { ...fields, scheduledFor: sentAt, quotaDay: quotaDay(sentAt, zone) });
  }
  await app().stepExecution.createMany({ data: rows });

  /** The persons whose latest touch falls on the run's quota day. */
  const touchedOn = (at: Date) =>
    run(async () => {
      const touched = new Set<string>();
      for (const personId of personIds) {
        const last = await lastTouchAt(personId);
        if (last !== null && quotaDay(last, zone) === quotaDay(at, zone)) touched.add(personId);
      }
      return touched;
    });
  const planned = new Map<string, Date>(kept);
  const planOnce = async (at: Date, what: string) => {
    setClocks(at);
    const left = await run(() => remainingToday(accountId));
    const touched = await touchedOn(at);
    const before = await stepsOf(workspaceId);
    await run(() => planAccount(accountId, at));
    const after = await stepsOf(workspaceId);
    const placed = checkRun({ zone, hours, at, left, before, after, touched, what });
    // The times still standing: kept from before, or placed now.
    for (const row of after) {
      if (row.status !== "scheduled" || time(row.scheduledFor) !== time(planned.get(row.id))) {
        planned.delete(row.id);
      }
    }
    for (const [id, placedAt] of placed) planned.set(id, placedAt);
    const sent = after.flatMap((row) => (row.executedAt === null ? [] : [row.executedAt]));
    checkGaps([...planned.values(), ...sent], what);
    return after;
  };

  const what = `${zone}, seed ${seed}`;
  const afterFirst = await planOnce(first, `${what}, first run at ${first.toISOString()}`);

  // The sender, between the runs: some of the times passed are sent, counted and touched.
  const second = new Date(first.getTime() + s.int(4 * 60) * MINUTE_MS);
  for (const row of afterFirst) {
    const at = row.scheduledFor;
    if (row.status !== "scheduled" || at === null || at > second || s.int(2) === 0) continue;
    await app().stepExecution.update({
      where: { id: row.id },
      data: { status: "succeeded", attempt: 1, executedAt: at },
    });
    planned.delete(row.id);
    const day = { senderAccountId: accountId, quotaDay: quotaDay(at, zone) };
    const committed = { [COMMITTED[linkedinActionType(row)]]: { increment: 1 } };
    await app().senderQuotaUsage.updateMany({ where: day, data: committed });
    await run(() => recordTouch(row.personId, at));
  }
  await planOnce(second, `${what}, second run at ${second.toISOString()}`);
}

test("over seeded accounts, persons with random priorities or none, and steps in three zones, two runs of the plan and the sends between them: no run passes remainingToday's limits or the actions left, leaves the window or the weekdays, gives a person two steps a day or one on a day touched, yields two times closer than the gap, nor moves or releases a kept step for a candidate", async () => {
  for (const zone of ZONES) {
    for (let seed = 1; seed <= SEEDS; seed += 1) await scenario(zone, seed);
  }
});

test("an account that may not send, remainingToday answering windowEnd null, gets nothing, its lead Hot: no time placed or released, and no row of linkedin's log", async () => {
  const workspaceId = "wsp_bounds_closed";
  const zone = "Asia/Kolkata";
  const hours = { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] };
  const { id: accountId } = await createConnectedAccount(workspaceId, {
    timeZone: zone,
    workingHours: hours,
  });
  const run = <T>(fn: (tx: TenantClient) => Promise<T>) =>
    withTenant({ workspaceId, principal: servicePrincipal("plan_bounds") }, fn, { client: app() });
  const at = new Date("2026-10-28T05:30:00Z"); // Wednesday 11:00 in Kolkata, the window open
  const personId = await run(() => personOf("https://linkedin.com/in/plan-bounds-closed"));
  await run(() => setLeadPriority(personId, PRIORITY_MAX)); // Hot, the highest there is
  const enrollmentId = newId(ids.enrollment);
  await app().enrollment.create({
    data: {
      ...{ id: enrollmentId, workspaceId, personId, senderAccountId: accountId, ...TEMPLATE },
      ...{ status: "active", sourceEventId: newId("obx"), startedAt: at },
    },
  });
  const step = (stepKey: string, fields: StepFields): Prisma.StepExecutionCreateManyInput => ({
    ...{ id: newId(ids.step_execution), workspaceId, enrollmentId, personId, ...TEMPLATE },
    ...{ senderAccountId: accountId, stepKey, position: 1, actionType: "invite" },
    ...{ stepTemplateHash: stepKey, idempotencyKey: stepKey, status: "scheduled" },
    ...{ dueAt: new Date(at.getTime() - DAY_MS), ...fields },
  });
  const stale = new Date(at.getTime() - HOUR_MS);
  await app().stepExecution.createMany({
    data: [step("due", {}), step("stale", { scheduledFor: stale, quotaDay: "2026-10-28" })],
  });
  // The plan's clock in the window; linkedin's past its end, so remainingToday answers windowEnd
  // null, as beta-p1-040 and beta-p6-010 make it answer while sending is closed or the account is
  // stopped or paused.
  useClock(() => at);
  useLinkedinClock(() => new Date("2026-10-28T13:00:00Z")); // 18:30 in Kolkata
  const before = await stepsOf(workspaceId);
  assert.equal((await run(() => remainingToday(accountId))).windowEnd, null);
  const plan = await run(() => planAccount(accountId, at));
  assert.deepEqual(plan, { skipped: "no_window", kept: 0, released: 0, placed: 0 });
  assert.deepEqual(await stepsOf(workspaceId), before);
  assert.equal(await app().senderActionLog.count({ where: { senderAccountId: accountId } }), 0);
});
