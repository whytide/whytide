import { canonicalLocale } from "./locale.ts";

/** A date for the locale through Intl: `Mar 4, 2026` in en-US, `4 Mar 2026` in en-GB; never hand-formatted (coding §4). */
export function formatDate(
  date: Date,
  locale: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
  return new Intl.DateTimeFormat(canonicalLocale(locale), options).format(date);
}

export function formatNumber(
  value: number | bigint,
  locale: string,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(canonicalLocale(locale), options).format(value);
}

export type RelativeOptions = {
  /** The instant to count from; the current time when unset. */
  readonly now?: Date;
  /** `auto` says "yesterday" and "now"; `always` says "1 day ago" and "in 0 seconds". */
  readonly numeric?: "always" | "auto";
  readonly style?: "long" | "short" | "narrow";
};

/** The unit that fits: seconds under a minute, then minutes, hours, days under 30, months under 12, years. */
const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 30],
  ["month", 12],
];

/** "2 days ago", "in 3 months": the locale's own words through Intl.RelativeTimeFormat, never a concatenation. */
export function formatRelative(date: Date, locale: string, options: RelativeOptions = {}): string {
  const now = options.now ?? new Date();
  let value = (date.getTime() - now.getTime()) / 1000;
  let unit: Intl.RelativeTimeFormatUnit = "year";
  for (const [candidate, next] of UNITS) {
    if (Math.abs(Math.round(value)) < next) {
      unit = candidate;
      break;
    }
    value /= next;
  }
  const format = new Intl.RelativeTimeFormat(canonicalLocale(locale), {
    numeric: options.numeric ?? "auto",
    style: options.style,
  });
  return format.format(Math.round(value), unit);
}
