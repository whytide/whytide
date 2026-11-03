// The daily job's deletes (docs/data.md; docs/flows.md "The daily job"): the provider events'
// receipts past EVENT_RECEIPT_DAYS, a global table with no person data, in transactions on the global
// client outside any run (store.ts inGlobal); and a workspace's action log past ACTION_LOG_DAYS, in
// runs of that workspace; PURGE_BATCH_ROWS rows a batch until none is left, so a retry goes on from
// what the attempt before committed. With erasePerson (domain/erase.ts), the only deletes of either.
import { tenantClient } from "@whytide/db";
import { DAY_MS } from "../quota/constants.ts";
import { inGlobal } from "../store.ts";
import { ACTION_LOG_DAYS, EVENT_RECEIPT_DAYS, PURGE_BATCH_ROWS } from "./constants.ts";

/** One tenant run of the workspace: the activity's `context.tenant`. */
export type TenantRun = <T>(fn: () => Promise<T>) => Promise<T>;
/** One batch: the rows it found, at most PURGE_BATCH_ROWS, and those it deleted. */
type Batch = { readonly found: number; readonly deleted: number };

/** The receipts older than EVENT_RECEIPT_DAYS at `at` deleted, a batch at a time; the count. */
export async function purgeReceipts(at: Date): Promise<number> {
  const before = new Date(at.getTime() - EVENT_RECEIPT_DAYS * DAY_MS);
  const batch = () =>
    inGlobal(async (db) => {
      const rows = await db.linkedinEventReceipt.findMany({
        where: { receivedAt: { lt: before } },
        select: { id: true },
        take: PURGE_BATCH_ROWS,
      });
      if (rows.length === 0) return { found: 0, deleted: 0 };
      const ids = rows.map((row) => row.id);
      const { count } = await db.linkedinEventReceipt.deleteMany({ where: { id: { in: ids } } });
      return { found: rows.length, deleted: count };
    }, "linkedin.retention");
  return inBatches(batch);
}

/** The workspace's action-log rows older than ACTION_LOG_DAYS at `at` deleted, a batch a run. */
export async function purgeActionLog(run: TenantRun, at: Date): Promise<number> {
  const before = new Date(at.getTime() - ACTION_LOG_DAYS * DAY_MS);
  return inBatches(() =>
    run(async () => {
      const rows = await tenantClient.senderActionLog.findMany({
        where: { at: { lt: before } },
        select: { id: true },
        take: PURGE_BATCH_ROWS,
      });
      if (rows.length === 0) return { found: 0, deleted: 0 };
      const ids = rows.map((row) => row.id);
      const { count } = await tenantClient.senderActionLog.deleteMany({
        where: { id: { in: ids } },
      });
      return { found: rows.length, deleted: count };
    }),
  );
}

/**
 * `batch` again until one finds fewer than PURGE_BATCH_ROWS rows, or deletes none, so that rows found
 * and never deleted cannot loop it; the rows deleted in all.
 */
async function inBatches(batch: () => Promise<Batch>): Promise<number> {
  let deleted = 0;
  for (;;) {
    const done = await batch();
    deleted += done.deleted;
    if (done.found < PURGE_BATCH_ROWS || done.deleted === 0) return deleted;
  }
}
