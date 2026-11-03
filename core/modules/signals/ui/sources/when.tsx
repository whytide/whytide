"use client";
// An instant on the sources screen: a <time> carrying its ISO value, in the words of the locale and
// in the time zone next-intl gives the page (the server's until the user's setting arrives), named.
import { useFormatter } from "next-intl";

export const FORMAT = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
} as const;

/** `stacked`, in a table's cell: the day over the time, each kept on its line. */
export function When({ at, stacked = false }: { at: string; stacked?: boolean }) {
  const format = useFormatter();
  const instant = new Date(at);
  if (!stacked) return <time dateTime={at}>{format.dateTime(instant, FORMAT)}</time>;
  const { hour, minute, timeZoneName, ...day } = FORMAT;
  return (
    <time dateTime={at} className="grid whitespace-nowrap">
      <span>{format.dateTime(instant, day)}</span>
      <span>{format.dateTime(instant, { hour, minute, timeZoneName })}</span>
    </time>
  );
}
