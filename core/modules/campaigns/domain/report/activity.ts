// active_day (README.md "Commands"; gamma's "Done when": at least 2 agents and 3 senders active each
// working day), pure, on the period's sends: each invite or message in linkedin's log that names a
// step execution, with its campaign while the step exists (one agent has one campaign, so a campaign
// stands for its agent) and its sender account. A row that names no step, as an Inbox reply's (`msg_`)
// does, is left out (the task's note of 2026-11-02); a step erased since keeps its sender.
import type { SendLogRow } from "@whytide/linkedin";
import { daysFrom, isWeekday, utcDay } from "./days.ts";
import { isAction, type Send } from "./sends.ts";

/** A send as the activity reads it: its UTC day, its campaign's key_ref or null, its sender. */
export type ActiveSend = {
  readonly day: string;
  readonly campaign: string | null;
  readonly senderAccountId: string;
};
/** A working day, and the campaigns and the sender accounts with at least one send in it. */
export type ActiveDay = {
  readonly day: string;
  readonly campaigns: number;
  readonly senders: number;
};

/** The sends the activity counts, from readSends' sends and missing rows (the file's header). */
export function activeSends(sends: readonly Send[], missing: readonly SendLogRow[]): ActiveSend[] {
  const kept = sends.map(({ row, step }) => ({
    day: utcDay(row.at),
    campaign: step.templateId,
    senderAccountId: row.senderAccountId,
  }));
  const erased = missing
    .filter((row) => row.stepExecutionId !== null && isAction(row))
    .map((row) => ({ day: utcDay(row.at), campaign: null, senderAccountId: row.senderAccountId }));
  return [...kept, ...erased];
}

/** The first day with a send, or null for none. */
export function firstDay(sends: readonly { readonly day: string }[]): string | null {
  return sends.reduce<string | null>(
    (first, { day }) => (first === null || day < first ? day : first),
    null,
  );
}

/** Each weekday from the first send's day to `lastDay`, the run's, with its counts; none without a send. */
export function activeDays(sends: readonly ActiveSend[], lastDay: string): ActiveDay[] {
  const first = firstDay(sends);
  if (first === null) return [];
  const byDay = new Map<string, { campaigns: Set<string>; senders: Set<string> }>();
  for (const { day, campaign, senderAccountId } of sends) {
    const held = byDay.get(day) ?? { campaigns: new Set<string>(), senders: new Set<string>() };
    if (campaign !== null) held.campaigns.add(campaign);
    held.senders.add(senderAccountId);
    byDay.set(day, held);
  }
  return daysFrom(first, lastDay)
    .filter(isWeekday)
    .map((day) => ({
      day,
      campaigns: byDay.get(day)?.campaigns.size ?? 0,
      senders: byDay.get(day)?.senders.size ?? 0,
    }));
}
