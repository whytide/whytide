// The cost counter's week (docs/concepts.md "Costs"): an ISO week in UTC, `2026-W44`, from its
// Monday at 00:00 to the next Monday, excluded, as contacts' weekly summary and qualification's golden
// set name a week. Pure: the screen picks its weeks with it in the browser too.

const DAY = 86_400_000;
const NAME = /^(\d{4})-W(\d{2})$/;

export type Week = { readonly week: string; readonly start: Date; readonly end: Date };

/** The ISO week holding the instant: the week is its Thursday's year's. */
export function weekOf(at: Date): Week {
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
  const thursday = new Date(monday + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const number = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY)) + 1;
  const week = `${year}-W${String(number).padStart(2, "0")}`;
  return { week, start: new Date(monday), end: new Date(monday + 7 * DAY) };
}

/** `2026-W44`: its instants; null for a week the year does not have, or another shape. */
export function weekRange(week: string): Week | null {
  const match = NAME.exec(week);
  if (match === null) return null;
  // Week 1 holds January 4th.
  const fourth = Date.UTC(Number(match[1]), 0, 4);
  const monday = fourth - ((new Date(fourth).getUTCDay() + 6) % 7) * DAY;
  const found = weekOf(new Date(monday + (Number(match[2]) - 1) * 7 * DAY));
  return Number(match[2]) >= 1 && found.week === week ? found : null;
}

/** The week holding the instant and the `count - 1` before it, newest first: the screen's picker. */
export function recentWeeks(at: Date, count: number): Week[] {
  return Array.from({ length: count }, (_, back) =>
    weekOf(new Date(at.getTime() - back * 7 * DAY)),
  );
}
