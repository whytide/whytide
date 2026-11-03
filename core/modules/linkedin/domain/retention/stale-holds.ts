// The daily sweep of the holds no reservation swept (docs/flows.md "The daily job"; beta-p1-030's
// review): a reservation's lazy sweep covers the day in use only, so a reservation of an earlier day
// past its hold stays `reserved`, and a send's keeps its day's slot, a connection request's counting
// in the week for up to six quota days. The daily job expires them as that sweep does, one day's row
// locked first in a run of its own, so it queues with the reservations and never holds two rows.
import { tenantClient } from "@whytide/db";
import { lockUsage, sweep } from "../quota/holds.ts";

/** The workspace's day rows holding a reservation past its hold at `at`, ids only. */
export async function staleDays(at: Date): Promise<string[]> {
  const rows = await tenantClient.senderQuotaReservation.findMany({
    where: { status: "reserved", expiresAt: { lte: at } },
    select: { usageId: true },
    distinct: ["usageId"],
    orderBy: { usageId: "asc" },
  });
  return rows.map((row) => row.usageId);
}

/**
 * The day's reservations past their hold at `at` expired, off their counters, its row locked first.
 */
export async function expireStale(usageId: string, at: Date): Promise<void> {
  if (!(await lockUsage(usageId))) return;
  const day = await tenantClient.senderQuotaUsage.findFirstOrThrow({ where: { id: usageId } });
  await sweep(day, at);
}
