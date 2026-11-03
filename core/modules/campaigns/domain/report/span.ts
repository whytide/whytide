// senders_three_weeks (README.md "Commands"; beta's "Done when": at least 3 senders ran outreach for
// at least 3 weeks), pure, on the period's `ok` rows: each sender's first and last invite or message,
// as UTC days, and the whole days between them. The command counts a sender at SENDER_SPAN_DAYS.
import type { SendLogRow } from "@whytide/linkedin";
import { daysBetween, utcDay } from "./days.ts";
import { isAction } from "./sends.ts";

/** A sender's first and last day with a send, `YYYY-MM-DD` in UTC, and the days between them. */
export type SenderSpan = {
  readonly senderAccountId: string;
  readonly first: string;
  readonly last: string;
  readonly days: number;
};

/** Each sender's span, by sender id; the rows come oldest first, as linkedin's sendLogRows gives them. */
export function senderSpans(rows: readonly SendLogRow[]): SenderSpan[] {
  const bySender = new Map<string, { first: string; last: string }>();
  for (const row of rows) {
    if (!isAction(row)) continue;
    const day = utcDay(row.at);
    const span = bySender.get(row.senderAccountId);
    bySender.set(row.senderAccountId, {
      first: span === undefined || day < span.first ? day : span.first,
      last: span === undefined || day > span.last ? day : span.last,
    });
  }
  return [...bySender]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([senderAccountId, { first, last }]) => ({
      senderAccountId,
      first,
      last,
      days: daysBetween(first, last),
    }));
}
