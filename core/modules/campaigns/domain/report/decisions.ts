// decision_days (README.md "Commands"; beta's "Done when": our team uses it every working day of the
// last week), in the caller's tenant run: of the weekdays, Monday to Friday, among the whole local
// days before the run's day, in each sender's zone, how many had a decision in "Up next", approved or
// skipped (approvals' decisionDays, which gives each decision's day in its sender's zone).
import { decisionDays } from "@whytide/approvals";
import { findSenderAccount, errors as linkedinErrors } from "@whytide/linkedin";
import { isAppError, quotaDay } from "@whytide/platform";
import { DECISION_READ_MARGIN_DAYS, FALLBACK_TIME_ZONE, MS_PER_DAY } from "./constants.ts";
import { addDays, isWeekday } from "./days.ts";

/** The weekdays of the window, and those with at least one decision. */
export type DecidedWeekdays = { readonly decided: number; readonly weekdays: number };

/**
 * The window is the `days` local days before the run's day in a sender's zone: whole days, so a run
 * early in the morning does not count today against the team. With several zones, the windows'
 * weekdays are counted together, each day once; with no decision, the window is UTC's.
 */
export async function decidedWeekdays(input: {
  readonly now: Date;
  readonly days: number;
}): Promise<DecidedWeekdays> {
  const { now, days } = input;
  const since = new Date(now.getTime() - (days + DECISION_READ_MARGIN_DAYS) * MS_PER_DAY);
  const decided = await decisionDays({ since });
  const zones = await zonesOf(decided.map(({ senderAccountId }) => senderAccountId));
  const windows = new Map<string, readonly string[]>();
  for (const zone of zones.size === 0 ? [FALLBACK_TIME_ZONE] : zones.values()) {
    if (!windows.has(zone)) windows.set(zone, weekdaysBefore(quotaDay(now, zone), days));
  }
  const hit = new Set<string>();
  for (const { senderAccountId, day } of decided) {
    const zone = zones.get(senderAccountId) ?? FALLBACK_TIME_ZONE;
    if (windows.get(zone)?.includes(day)) hit.add(day);
  }
  const weekdays = new Set([...windows.values()].flat());
  return { decided: hit.size, weekdays: weekdays.size };
}

/** The weekdays among the `days` days before `today`, `YYYY-MM-DD`. */
export function weekdaysBefore(today: string, days: number): string[] {
  const before = Array.from({ length: days }, (_, back) => addDays(today, -(back + 1)));
  return before.filter(isWeekday);
}

/** Each sender's zone: linkedin's account's, or the fallback for one it no longer holds. */
async function zonesOf(senderAccountIds: readonly string[]): Promise<Map<string, string>> {
  const zones = new Map<string, string>();
  for (const id of new Set(senderAccountIds)) {
    try {
      zones.set(id, (await findSenderAccount(id)).timeZone);
    } catch (error) {
      if (!isAppError(error) || error.code !== linkedinErrors.sender_account_not_found) throw error;
      zones.set(id, FALLBACK_TIME_ZONE);
    }
  }
  return zones;
}
