// The usage rows of a workspace (README "Public interface"), for GET …/credits/usage: newest first, a
// page at a time, in the request's run.
import type { TenantClient } from "@whytide/db";
import type { UsageQuery, UsageResponse } from "../schemas/credits.ts";

export async function listUsage(tx: TenantClient, query: UsageQuery): Promise<UsageResponse> {
  const { from, to, cursor, limit } = query;
  const createdAt = { gte: from && new Date(from), lt: to && new Date(to) };
  const rows = await tx.creditUsage.findMany({
    where: { createdAt },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
  });
  const page = rows.slice(0, limit);
  const items = page.map((row) => ({
    id: row.id,
    action: row.action,
    quantity: row.quantity.toFixed(),
    credits: row.credits.toFixed(),
    status: row.status,
    subjectRef: row.subjectRef,
    createdAt: row.createdAt.toISOString(),
    leaseExpiresAt: row.leaseExpiresAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
    priceListVersion: row.priceListVersion,
  }));
  return { items, nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
}
