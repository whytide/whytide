// One account's daily plan (docs/flows.md "The daily plan", step 2), in the caller's tenant run, on
// its transaction: linkedin's account and what it may still send today, the account's `scheduled`
// steps, contacts' touches; the rules of place.ts; then the writes, each conditional on the step as
// it was read, so a step the sender claimed meanwhile, or that left `scheduled`, is left alone. The
// plan reads and writes no other status: an `executing` step is its sender's alone. It reads
// LinkedIn's steps only, by their actions: an email step is never placed (gamma-p3-030); and none
// of a paused enrollment, or of a campaign that is not active (gamma-p3-060, ../pause/), whose
// placed steps the gate puts back at their claim. gamma-p6-040: first, the account's plan lock for
// the run's transaction (lock.ts); an account another run is planning is skipped (`busy`).
// gamma-p5-070: then qualification's priorities of the due steps' persons, which order the
// candidates inside messages and invites (place.ts byPriority), never the room, the hours or the
// touches.
import { errors as contacts, lastTouchAt } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import {
  findSenderAccount,
  errors as linkedin,
  remainingToday,
  type SenderAccount,
} from "@whytide/linkedin";
import {
  isAppError,
  isWindowOpen,
  type LocalHours,
  MONDAY_TO_FRIDAY,
  quotaDay,
} from "@whytide/platform";
import { leadPriorities } from "@whytide/qualification";
import { random } from "../clock.ts";
import { pausesOf } from "../pause/status.ts";
import { linkedinActionType, linkedinOnly, linkedinSenderAccount } from "../steps/actions.ts";
import { MIN_ACTION_GAP_MS, PRIORITY_READ_MAX } from "./constants.ts";
import { lockPlan } from "./lock.ts";
import { chooseSteps, isDue, type PlanStep, placeTimes, sortSteps } from "./place.ts";

/**
 * Why an account got nothing this run: another run is planning it (gamma-p6-040), not connected,
 * its window closed, or none left today.
 */
export type PlanSkip = "busy" | "not_connected" | "window_closed" | "no_window";
/** What one run did for the account, counted. */
export type AccountPlan = {
  readonly skipped: PlanSkip | null;
  readonly kept: number;
  readonly released: number;
  readonly placed: number;
};

const read = {
  id: true,
  personId: true,
  actionType: true,
  position: true,
  dueAt: true,
  scheduledFor: true,
  quotaDay: true,
} as const;

/** The sender accounts of the workspace's `scheduled` LinkedIn steps, sorted. */
export async function scheduledAccounts(): Promise<string[]> {
  const rows = await tenantClient.stepExecution.findMany({
    where: { status: "scheduled", ...linkedinOnly() },
    distinct: ["senderAccountId"],
    select: { id: true, senderAccountId: true },
    orderBy: { senderAccountId: "asc" },
  });
  return rows.map(linkedinSenderAccount);
}

/**
 * Plans the account's due steps at `at` (the file's header): nothing for an account another run is
 * planning, or that is not connected, outside its window cut to Monday to Friday, or with no window
 * left today, which is also how an account that may not send is skipped (remainingToday answers
 * windowEnd null).
 */
export async function planAccount(accountId: string, at: Date): Promise<AccountPlan> {
  if (!(await lockPlan(accountId))) return skip("busy");
  const account = await connected(accountId);
  if (account === null) return skip("not_connected");
  const { timeZone } = account;
  const hours: LocalHours = { ...account.workingHours, days: weekdaysOf(account) };
  if (!isWindowOpen(at, timeZone, hours)) return skip("window_closed");
  const left = await remainingToday(accountId);
  if (left.windowEnd === null) return skip("no_window");

  const today = quotaDay(at, timeZone);
  const steps = await scheduledSteps(accountId);
  const sorted = sortSteps(steps, at, today, await duePriorities(steps, at));
  const touched = await touchedOn(today, timeZone, sorted.candidates);
  const plan = chooseSteps({ ...sorted, capacity: left, touched });
  const released = await release([...sorted.stale, ...plan.dropped]);
  const last = await lastExecutedAt(accountId);
  const earliest = last === null ? at : new Date(last.getTime() + MIN_ACTION_GAP_MS);
  const placements = placeTimes({
    items: plan.chosen,
    from: earliest > at ? earliest : at,
    to: left.windowEnd,
    kept: plan.kept.map((step) => step.scheduledFor as Date),
    random,
    open: (time) => isWindowOpen(time, timeZone, hours),
  });
  let placed = 0;
  for (const { item, at: time } of placements) {
    const data = { scheduledFor: time, quotaDay: quotaDay(time, timeZone) };
    const where = { id: item.id, status: "scheduled", scheduledFor: null } as const;
    placed += (await tenantClient.stepExecution.updateMany({ where, data })).count;
  }
  return { skipped: null, kept: plan.kept.length, released, placed };
}

/** The account when it is `connected`, else null; an id linkedin does not know is none either. */
async function connected(accountId: string): Promise<SenderAccount | null> {
  try {
    const account = await findSenderAccount(accountId);
    return account.status === "connected" ? account : null;
  } catch (error) {
    if (isAppError(error) && error.code === linkedin.sender_account_not_found) return null;
    throw error;
  }
}

/** The account's working days cut to Monday to Friday, whatever days it lists. */
const weekdaysOf = (account: SenderAccount): number[] =>
  MONDAY_TO_FRIDAY.filter((day) => account.workingHours.days.includes(day));

const skip = (skipped: PlanSkip): AccountPlan => ({ skipped, kept: 0, released: 0, placed: 0 });

async function scheduledSteps(accountId: string): Promise<PlanStep[]> {
  const where = { senderAccountId: accountId, status: "scheduled", ...linkedinOnly() } as const;
  const rows = await tenantClient.stepExecution.findMany({
    where,
    select: { ...read, enrollmentId: true },
    orderBy: { id: "asc" },
  });
  const waiting = await pausesOf(rows.map(({ enrollmentId }) => enrollmentId));
  return rows.flatMap(({ enrollmentId, ...row }) =>
    waiting.has(enrollmentId) ? [] : [{ ...row, actionType: linkedinActionType(row) }],
  );
}

/**
 * The priorities of the due steps' persons, qualification's leadPriorities in the caller's run: one
 * call, or one per PRIORITY_READ_MAX persons past it. A person with no intent row has none.
 */
export async function duePriorities(
  steps: readonly PlanStep[],
  at: Date,
): Promise<Map<string, number>> {
  const due = steps.filter((step) => isDue(step, at));
  const persons = [...new Set(due.map((step) => step.personId))];
  const priorities = new Map<string, number>();
  for (let start = 0; start < persons.length; start += PRIORITY_READ_MAX) {
    const page = persons.slice(start, start + PRIORITY_READ_MAX);
    for (const { personId, priority } of await leadPriorities(page)) {
      priorities.set(personId, priority);
    }
  }
  return priorities;
}

/**
 * The candidates' persons whose latest touch, in contacts, falls on `today` in the account's zone,
 * and those contacts no longer has (person_not_found, erased meanwhile): their steps wait.
 */
async function touchedOn(
  today: string,
  timeZone: string,
  candidates: readonly PlanStep[],
): Promise<Set<string>> {
  const touched = new Set<string>();
  for (const personId of new Set(candidates.map((step) => step.personId))) {
    try {
      const last = await lastTouchAt(personId);
      if (last !== null && quotaDay(last, timeZone) === today) touched.add(personId);
    } catch (error) {
      if (!(isAppError(error) && error.code === contacts.person_not_found)) throw error;
      touched.add(personId);
    }
  }
  return touched;
}

/** Each step's time and quota day back to null, if it is still `scheduled` at the time read. */
async function release(steps: readonly PlanStep[]): Promise<number> {
  let released = 0;
  for (const step of steps) {
    const where = { id: step.id, status: "scheduled", scheduledFor: step.scheduledFor } as const;
    const data = { scheduledFor: null, quotaDay: null };
    released += (await tenantClient.stepExecution.updateMany({ where, data })).count;
  }
  return released;
}

/**
 * Whether the account, connected, has a `scheduled` step placed on today's quota day in its zone at
 * `at`: the plan then starts its sender (beta-p4-020; workflows/index.ts).
 */
export async function placedToday(accountId: string, at: Date): Promise<boolean> {
  const account = await connected(accountId);
  if (account === null) return false;
  const today = quotaDay(at, account.timeZone);
  const where = { senderAccountId: accountId, status: "scheduled", quotaDay: today } as const;
  return (await tenantClient.stepExecution.count({ where })) > 0;
}

/** The account's latest send, whatever the step's status now: the plan's and the sender's gap. */
export async function lastExecutedAt(accountId: string): Promise<Date | null> {
  const { _max } = await tenantClient.stepExecution.aggregate({
    where: { senderAccountId: accountId },
    _max: { executedAt: true },
  });
  return _max.executedAt;
}
