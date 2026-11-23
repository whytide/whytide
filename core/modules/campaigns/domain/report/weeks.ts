// active_workspaces (README.md "Commands"; gamma's "Done when": the friends keep using it), pure: each
// ISO week (UTC) from the first send's to the run's, and whether the workspace had at least one send
// in it, a weekend's included. The command counts the workspaces per week.
import { type ActiveSend, firstDay } from "./activity.ts";
import { daysFrom, isoWeekOf } from "./days.ts";

/** An ISO week, `YYYY-Www`, and whether it had a send. */
export type ActiveWeek = { readonly week: string; readonly active: boolean };

/** The weeks from the first send's to `lastDay`'s, in order; none without a send. */
export function activeWeeks(sends: readonly ActiveSend[], lastDay: string): ActiveWeek[] {
  const first = firstDay(sends);
  if (first === null) return [];
  const sent = new Set(sends.map(({ day }) => isoWeekOf(day)));
  const weeks = [...new Set(daysFrom(first, lastDay).map(isoWeekOf))];
  return weeks.map((week) => ({ week, active: sent.has(week) }));
}
