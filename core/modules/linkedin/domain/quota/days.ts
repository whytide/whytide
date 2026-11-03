// An account's usage row of a quota day (docs/flows.md), in the caller's tenant run: read, or made
// when missing with its limits drawn once (limits.ts), in the insert that makes it (INSERT … ON
// CONFLICT DO NOTHING), so a second insert of the same day, a concurrent one included, keeps the
// first draw. A reservation locks the row to the run's end (SELECT … FOR UPDATE) before it reads
// it, so the account's reservations queue on it; the usage route and remainingToday read it without
// the lock. A row keeps the zone it was made in and stays the account's day until that day is over
// there and in the account's zone now (limits.ts dayEndsAt): a zone changed mid-day takes effect from
// the next local day.
import { tenantClient } from "@whytide/db";
import { currentTenant, instantAt, newId, quotaDay } from "@whytide/platform";
import { ids } from "../../ids.ts";
import type { SenderAccount } from "../accounts.ts";
import { random } from "../clock.ts";
import { QUOTA_DAY_START, WEEK_QUOTA_DAYS, ZONE_DAYS } from "./constants.ts";
import { type DayUsage, dayEndsAt, drawDayLimits, quotaDayBefore, windowLeft } from "./limits.ts";

export type Day = DayUsage & {
  readonly id: string;
  readonly quotaDay: string;
  readonly timeZone: string;
  /** When the day's pending-invite check may run, drawn with the row (null: no window was left), and when it ran. */
  readonly checkAfter: Date | null;
  readonly checkedAt: Date | null;
};

/**
 * The account's row of its quota day at `at`: the day in use while it lasts, else the date at `at`
 * in its zone, made when missing in that zone; locked when asked.
 */
export async function dayOf(account: SenderAccount, at: Date, lock: boolean): Promise<Day> {
  const date = (await dateInUse(account, at)) ?? quotaDay(at, account.timeZone);
  const found = await readDay(account.id, date, lock);
  if (found !== null) return found;
  const { checkAfter, ...limits } = drawDayLimits(
    account,
    windowLeft(at, account.timeZone, account.workingHours),
    random,
  );
  const { workspaceId } = currentTenant();
  await tenantClient.senderQuotaUsage.createMany({
    data: [
      {
        id: newId(ids.sender_quota_usage),
        workspaceId,
        senderAccountId: account.id,
        quotaDay: date,
        timeZone: account.timeZone,
        ...limits,
        checkAfter,
      },
    ],
    skipDuplicates: true,
  });
  const made = await readDay(account.id, date, lock);
  if (made === null) throw new Error("no usage row after its insert");
  return made;
}

/** The account's row of its quota day at `at`, as dayOf finds it, locked; null, none made, if none. */
export async function lockDayInUse(
  account: Pick<SenderAccount, "id" | "timeZone">,
  at: Date,
): Promise<Day | null> {
  const date = (await dateInUse(account, at)) ?? quotaDay(at, account.timeZone);
  return readDay(account.id, date, true);
}

/** The connection requests, reserved and made, of the six quota days before `date`. */
export async function invitesBefore(senderAccountId: string, date: string): Promise<number> {
  let invites = 0;
  for (const count of (await invitesByDay(senderAccountId, date)).values()) invites += count;
  return invites;
}

/** The connection requests, reserved and made, of each of the six quota days before `date`. */
export async function invitesByDay(
  senderAccountId: string,
  date: string,
): Promise<Map<string, number>> {
  const rows = await tenantClient.senderQuotaUsage.findMany({
    where: {
      senderAccountId,
      quotaDay: { gte: quotaDayBefore(date, WEEK_QUOTA_DAYS - 1), lt: date },
    },
    select: { quotaDay: true, invitesReserved: true, invitesCommitted: true },
  });
  return new Map(rows.map((row) => [row.quotaDay, row.invitesReserved + row.invitesCommitted]));
}

/**
 * The date of the account's latest row whose day is on at `at`: begun in the zone it was made in, and
 * not over (dayEndsAt); null when none is. A row's date and zone never change, so this read needs no
 * lock; the row itself is then locked by its date, whose statement answers.
 */
async function dateInUse(
  account: Pick<SenderAccount, "id" | "timeZone">,
  at: Date,
): Promise<string | null> {
  const date = quotaDay(at, account.timeZone);
  const rows = await tenantClient.senderQuotaUsage.findMany({
    where: {
      senderAccountId: account.id,
      quotaDay: { gte: quotaDayBefore(date, ZONE_DAYS), lte: quotaDayBefore(date, -ZONE_DAYS) },
    },
    select: { quotaDay: true, timeZone: true },
    orderBy: { quotaDay: "desc" },
  });
  const on = rows.find(
    (row) =>
      instantAt(row.quotaDay, QUOTA_DAY_START, row.timeZone) <= at &&
      at < dayEndsAt(row, account.timeZone),
  );
  return on?.quotaDay ?? null;
}

/**
 * The row, or null. Locked, the locking statement itself answers: a row another run inserted and has
 * not committed is neither seen nor locked there, so this answers null and the caller's insert waits
 * for that run (ON CONFLICT); a read after a lock that found none could see that run's row, committed
 * meanwhile, unlocked. Once locked, the row is read by its id as the lock holds it.
 */
async function readDay(senderAccountId: string, date: string, lock: boolean): Promise<Day | null> {
  if (!lock) {
    return tenantClient.senderQuotaUsage.findFirst({ where: { senderAccountId, quotaDay: date } });
  }
  const locked = await lockDay(senderAccountId, date);
  if (locked === null) return null;
  return tenantClient.senderQuotaUsage.findFirstOrThrow({ where: { id: locked } });
}

/** The account's row of `date` locked to the run's end, in the run's workspace only: its id, or null. */
export async function lockDay(senderAccountId: string, date: string): Promise<string | null> {
  const [locked] = await tenantClient.$queryRaw<{ id: string }[]>`
    SELECT id FROM sender_quota_usage
    WHERE workspace_id = ${currentTenant().workspaceId} AND sender_account_id = ${senderAccountId}
      AND quota_day = ${date}
    FOR UPDATE`;
  return locked?.id ?? null;
}
