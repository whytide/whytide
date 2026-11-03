// One account's daily plan (docs/flows.md "The daily plan", step 2), in the caller's tenant run, on
// its transaction: linkedin's account and what it may still send today, the account's `scheduled`
// steps, contacts' touches; the rules of place.ts; then the writes, each conditional on the step as
// it was read, so a step the sender claimed meanwhile, or that left `scheduled`, is left alone. The
// plan reads and writes no other status: an `executing` step is its sender's alone.
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
import { random } from "../clock.ts";
import { MIN_ACTION_GAP_MS } from "./constants.ts";
import { chooseSteps, type PlanStep, placeTimes, sortSteps } from "./place.ts";

/** Why an account got nothing this run: not connected, its window closed, or none left today. */
export type PlanSkip = "not_connected" | "window_closed" | "no_window";
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

/** The sender accounts of the workspace's `scheduled` steps, sorted. */
export async function scheduledAccounts(): Promise<string[]> {
  const rows = await tenantClient.stepExecution.findMany({
    where: { status: "scheduled" },
    distinct: ["senderAccountId"],
    select: { senderAccountId: true },
    orderBy: { senderAccountId: "asc" },
  });
  return rows.map((row) => row.senderAccountId);
}

/**
 * Plans the account's due steps at `at` (the file's header): nothing for an account that is not
 * connected, outside its window cut to Monday to Friday, or with no window left today, which is also
 * how an account that may not send is skipped (remainingToday answers windowEnd null).
 */
export async function planAccount(accountId: string, at: Date): Promise<AccountPlan> {
  const account = await connected(accountId);
  if (account === null) return skip("not_connected");
  const { timeZone } = account;
  const hours: LocalHours = { ...account.workingHours, days: weekdaysOf(account) };
  if (!isWindowOpen(at, timeZone, hours)) return skip("window_closed");
  const left = await remainingToday(accountId);
  if (left.windowEnd === null) return skip("no_window");

  const today = quotaDay(at, timeZone);
  const sorted = sortSteps(await scheduledSteps(accountId), at, today);
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
  const where = { senderAccountId: accountId, status: "scheduled" } as const;
  return tenantClient.stepExecution.findMany({ where, select: read, orderBy: { id: "asc" } });
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
