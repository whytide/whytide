// The day's budgets (docs/concepts.md "Budgets"; briefs RB-11.2.1, RB-11.2.2), pure: the limits a
// day's usage row is made with, drawn once from the account's targets, and what is left of each
// budget from that row, the six quota days before it and the account's read cap. The hard maximums
// bound every answer here as the CHECKs of linkedin_send_quotas bound the row.
import { instantAt, quotaDay, randomTimesInWindow } from "@whytide/platform";
import type { SendActionType } from "../../schemas/quota.ts";
import type { WorkingHours } from "../working-hours.ts";
import {
  ACTIONS_PER_DAY_MAX,
  CHECK_DRAW_MS,
  CHECK_END_MARGIN_MS,
  DATE_LENGTH,
  DAY_LIMIT_DRAW,
  DAY_MS,
  INVITES_PER_DAY,
  INVITES_PER_WEEK,
  ISO_SUNDAY,
  MESSAGES_PER_DAY,
  QUOTA_DAY_START,
  READS_PER_DAY_MAX,
  WEEK_QUOTA_DAYS,
  WITHDRAWALS_PER_DAY_MAX,
} from "./constants.ts";

/** The account's numbers the draw and the read budget read. */
export type QuotaAccount = {
  readonly inviteTarget: number;
  readonly messageTarget: number;
  readonly dailyReadCap: number;
};
/** A day's usage row: its limits, and per action type what is reserved and what is made. */
export type DayUsage = {
  readonly inviteLimit: number;
  readonly invitesReserved: number;
  readonly invitesCommitted: number;
  readonly messageLimit: number;
  readonly messagesReserved: number;
  readonly messagesCommitted: number;
  readonly withdrawalsReserved: number;
  readonly withdrawalsCommitted: number;
  readonly readAllowance: number;
  readonly readsReserved: number;
  readonly readsCommitted: number;
};
export type DayLimits = {
  readonly inviteLimit: number;
  readonly messageLimit: number;
  readonly readAllowance: number;
  /** When the day's pending-invite check may run: early in what is left of the window, else null. */
  readonly checkAfter: Date | null;
};
/** What is left today of each budget, each within the actions left of the 200. */
export type Remaining = {
  readonly invites: number;
  readonly messages: number;
  readonly withdrawals: number;
  readonly reads: number;
  readonly actions: number;
};
export type Window = { readonly from: Date; readonly to: Date };
/** A usage row's date and the zone it was made in. */
export type QuotaDay = { readonly quotaDay: string; readonly timeZone: string };

/**
 * A day's limits, drawn once, as the row that holds them is made: each send limit the target times a
 * uniform draw from DAY_LIMIT_DRAW, rounded down (every whole number from 80 percent of the target to
 * the target equally likely), never above its hard maximum; the read allowance the account's cap,
 * never above READS_PER_DAY_MAX nor what the 200 leaves after the two limits and the withdrawals, so
 * sends get their share first; and `checkAfter` (checkAfterOf), null without a window.
 */
export function drawDayLimits(
  account: QuotaAccount,
  window: Window | null,
  random: () => number,
): DayLimits {
  const inviteLimit = drawLimit(account.inviteTarget, INVITES_PER_DAY.max, random);
  const messageLimit = drawLimit(account.messageTarget, MESSAGES_PER_DAY.max, random);
  const afterSends = ACTIONS_PER_DAY_MAX - inviteLimit - messageLimit - WITHDRAWALS_PER_DAY_MAX;
  const readAllowance = Math.max(Math.min(account.dailyReadCap, READS_PER_DAY_MAX, afterSends), 0);
  const checkAfter = window === null ? null : checkAfterOf(window, random);
  return { inviteLimit, messageLimit, readAllowance, checkAfter };
}

/**
 * A day's send limits once its account's targets fell (the owner's resume, beta-p6-040): each the
 * smaller of the stored limit and a new draw from its target, as drawDayLimits draws, so a limit
 * never rises; the read allowance and the check stay as the row holds them.
 */
export function lowerDayLimits(
  day: Pick<DayLimits, "inviteLimit" | "messageLimit">,
  targets: Pick<QuotaAccount, "inviteTarget" | "messageTarget">,
  random: () => number,
): Pick<DayLimits, "inviteLimit" | "messageLimit"> {
  const invites = drawLimit(targets.inviteTarget, INVITES_PER_DAY.max, random);
  const messages = drawLimit(targets.messageTarget, MESSAGES_PER_DAY.max, random);
  return {
    inviteLimit: Math.min(day.inviteLimit, invites),
    messageLimit: Math.min(day.messageLimit, messages),
  };
}

/**
 * A random instant within CHECK_DRAW_MS of the window's start, never within CHECK_END_MARGIN_MS of
 * its end; the start itself when the window leaves no such instant.
 */
export function checkAfterOf(window: Window, random: () => number): Date {
  const from = window.from.getTime();
  const to = Math.min(from + CHECK_DRAW_MS, window.to.getTime() - CHECK_END_MARGIN_MS);
  const draw = { from: window.from, to: new Date(to), count: 1, minGapMs: 0, random };
  const [checkAfter = window.from] = randomTimesInWindow(draw);
  return checkAfter;
}

/**
 * What is left today: connection requests within the day's limit and the weekly cap over the six
 * quota days before (`usage.invitesBefore`, reserved and made) and today; messages within the day's
 * limit; withdrawals within WITHDRAWALS_PER_DAY_MAX; reads within readsLeft; each within the 200.
 */
export function limitsFor(
  account: Pick<QuotaAccount, "dailyReadCap">,
  day: DayUsage,
  usage: { readonly invitesBefore: number },
): Remaining {
  const actions = actionsLeft(day);
  const invites = Math.min(sendsLeft(day, "invite"), weekLeft(day, usage.invitesBefore));
  return {
    invites: Math.min(invites, actions),
    messages: Math.min(sendsLeft(day, "message"), actions),
    withdrawals: Math.min(sendsLeft(day, "withdraw"), actions),
    reads: Math.min(readsLeft(account, day), actions),
    actions,
  };
}

/** The sends of the type left today by the day's own limit alone (15 withdrawals), the week and the 200 aside. */
export function sendsLeft(day: DayUsage, type: SendActionType): number {
  if (type === "invite") {
    const limit = Math.min(day.inviteLimit, INVITES_PER_DAY.max);
    return left(limit, day.invitesReserved + day.invitesCommitted);
  }
  if (type === "message") {
    const limit = Math.min(day.messageLimit, MESSAGES_PER_DAY.max);
    return left(limit, day.messagesReserved + day.messagesCommitted);
  }
  return left(WITHDRAWALS_PER_DAY_MAX, day.withdrawalsReserved + day.withdrawalsCommitted);
}

/** The connection requests the week leaves: the cap less those of the six quota days before and today. */
export function weekLeft(day: DayUsage, invitesBefore: number): number {
  const today = day.invitesReserved + day.invitesCommitted;
  return left(Math.min(INVITES_PER_WEEK.cap, INVITES_PER_WEEK.max), invitesBefore + today);
}

/**
 * How many quota days after `date` the week first leaves room for one more connection request, 1 to
 * 7: the week ending that day counts the days of `invitesByDay` (`YYYY-MM-DD` to the connection
 * requests reserved and made) still inside it, and none after `date`.
 */
export function weekOpensIn(date: string, invitesByDay: ReadonlyMap<string, number>): number {
  const cap = Math.min(INVITES_PER_WEEK.cap, INVITES_PER_WEEK.max);
  for (let ahead = 1; ahead < WEEK_QUOTA_DAYS; ahead++) {
    const first = quotaDayBefore(date, WEEK_QUOTA_DAYS - 1 - ahead);
    let invites = 0;
    for (const [day, count] of invitesByDay) if (day >= first && day <= date) invites += count;
    if (invites < cap) return ahead;
  }
  return WEEK_QUOTA_DAYS;
}

/**
 * When the quota day in use ends: once its date is over both in the zone its row was made in and in
 * the account's zone now, so a zone changed mid-day takes effect from the next local day and opens no
 * second day's budgets within it (README.md "Decided here").
 */
export function dayEndsAt(day: QuotaDay, accountZone: string): Date {
  return dayStartsAt(quotaDayBefore(day.quotaDay, -1), day, accountZone);
}

/** The start of the quota day `date`, after `day` in use: never before `day` ends, in either zone. */
export function dayStartsAt(date: string, day: QuotaDay, accountZone: string): Date {
  const next = quotaDayBefore(day.quotaDay, -1);
  const ends = [
    instantAt(next, QUOTA_DAY_START, day.timeZone),
    instantAt(next, QUOTA_DAY_START, accountZone),
    instantAt(date, QUOTA_DAY_START, accountZone),
  ];
  return new Date(Math.max(...ends.map((end) => end.getTime())));
}

/** The ISO day, 1 for Monday to 7 for Sunday, at `at` in the zone. */
export const isoDayAt = (at: Date, timeZone: string): number => isoDayOf(quotaDay(at, timeZone));

/** The day's reads at most: the smaller of its allowance and the account's cap now, at most 100. */
export function readLimit(account: Pick<QuotaAccount, "dailyReadCap">, day: DayUsage): number {
  return Math.min(day.readAllowance, account.dailyReadCap, READS_PER_DAY_MAX);
}

/** The reads left today by the read budget alone, the 200 aside. */
export function readsLeft(account: Pick<QuotaAccount, "dailyReadCap">, day: DayUsage): number {
  return left(readLimit(account, day), day.readsReserved + day.readsCommitted);
}

/** Every action of the day, reserved and made: connection requests, messages, withdrawals, reads. */
export function actionsUsed(day: DayUsage): number {
  return (
    day.invitesReserved +
    day.invitesCommitted +
    day.messagesReserved +
    day.messagesCommitted +
    day.withdrawalsReserved +
    day.withdrawalsCommitted +
    day.readsReserved +
    day.readsCommitted
  );
}

/** The actions left of the 200. */
export const actionsLeft = (day: DayUsage): number => left(ACTIONS_PER_DAY_MAX, actionsUsed(day));

/**
 * What is left of today's window after `at`, in the account's zone: from the later of `at` and the
 * start until the end; null on a day that is not a working day, or once the end has passed.
 */
export function windowLeft(at: Date, timeZone: string, hours: WorkingHours): Window | null {
  const date = quotaDay(at, timeZone);
  if (!hours.days.includes(isoDayOf(date))) return null;
  const start = instantAt(date, hours.start, timeZone);
  const end = instantAt(date, hours.end, timeZone);
  if (end <= at) return null;
  return { from: start > at ? start : at, to: end };
}

/** The quota day `days` days before `date`, `YYYY-MM-DD`: text that compares in date order. */
export function quotaDayBefore(date: string, days: number): string {
  const day = new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY_MS);
  return day.toISOString().slice(0, DATE_LENGTH);
}

function drawLimit(target: number, max: number, random: () => number): number {
  const low = Math.floor(target * DAY_LIMIT_DRAW.min);
  const high = Math.floor(target * DAY_LIMIT_DRAW.max);
  const value = random();
  if (!(value >= 0 && value < 1)) throw new Error("a draw outside [0, 1)");
  return Math.max(Math.min(low + Math.floor(value * (high - low + 1)), max), 0);
}

const left = (limit: number, used: number): number => Math.max(limit - used, 0);

/** 1 for Monday to 7 for Sunday, which getUTCDay numbers 0. */
const isoDayOf = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay() || ISO_SUNDAY;
