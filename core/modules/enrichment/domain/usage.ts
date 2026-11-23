// The allowance counter (README "Allowances"): one row of source_usage per source and period for the
// whole instance, shared by every workspace, read and written outside any run on the global table.
// A call is counted before it goes and counts whatever it answers, the safe side for a free plan; a
// vendor's word that its free calls are gone marks the period spent. Periods are calendar days and
// months in UTC. A source with no allowance is counted by the day with no limit, and a vendor's word
// still stops it until the day ends.
import type { TenantClient } from "@whytide/db";
import { newId } from "@whytide/platform";
import type { Allowance } from "@whytide/providers";
import { ids } from "../ids.ts";
import { now } from "./clock.ts";
import { inGlobal } from "./store.ts";

type Period = Allowance["per"];

/** The first day of the period `at` falls in, in UTC, `YYYY-MM-DD`. */
export function periodStart(at: Date, per: Period): string {
  const day = at.toISOString().slice(0, 10);
  return per === "month" ? `${day.slice(0, 8)}01` : day;
}

/**
 * Counts one call of `source` in the current period, only while the count stays within the
 * allowance and the period is not spent: whether the call may go. One conditional update, so two
 * callers at once never pass the allowance together.
 */
export function reserveCall(source: string, allowance: Allowance | null): Promise<boolean> {
  return inGlobal(async (db) => {
    const at = now();
    const key = await counter(db, source, allowance?.per ?? "day", at);
    const room = allowance === null ? {} : { used: { lt: allowance.calls } };
    const { count } = await db.sourceUsage.updateMany({
      where: { ...key, spent: false, ...room },
      data: { used: { increment: 1 }, updatedAt: at },
    });
    return count === 1;
  });
}

/**
 * Whether `source` has a call left in the current period, read only: not spent and, with an
 * allowance, under it. A period with no row yet has every call left.
 */
export function hasRoom(source: string, allowance: Allowance | null): Promise<boolean> {
  return inGlobal(async (db) => {
    const key = { source, periodStart: periodStart(now(), allowance?.per ?? "day") };
    const row = await db.sourceUsage.findFirst({ where: key, select: { used: true, spent: true } });
    const used = row?.used ?? 0;
    return row?.spent !== true && (allowance === null || used < allowance.calls);
  });
}

/** Marks the current period of `source` spent: no call until it ends. */
export function markSpent(source: string, allowance: Allowance | null): Promise<void> {
  return inGlobal(async (db) => {
    const at = now();
    const key = await counter(db, source, allowance?.per ?? "day", at);
    await db.sourceUsage.updateMany({ where: key, data: { spent: true, updatedAt: at } });
  });
}

/** The period's row, made at 0 unless another caller made it first: its key. */
async function counter(db: TenantClient, source: string, period: Period, at: Date) {
  const key = { source, periodStart: periodStart(at, period) };
  const id = newId(ids.source_usage);
  await db.sourceUsage.createMany({
    data: [{ id, ...key, period, used: 0, spent: false, updatedAt: at }],
    skipDuplicates: true,
  });
  return key;
}
