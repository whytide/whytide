// duplicate_sends (README.md "Commands"; RB-23.4.1: no step reaches the same person twice), in the
// caller's tenant run: a step execution with more than one `ok` invite or message row in linkedin's
// log, and an idempotency key held by more than one `succeeded` step execution, which the partial key
// step_executions_key_claimed refuses unless it is gone; either listed when one of its sends is in
// the period, so a second send in the period whose first went out before it counts. The log sees a
// second send only when linkedin wrote a row for it: the check after an unknown outcome writes none
// when one exists (beta-p1-050).
import { tenantClient } from "@whytide/db";
import { type SendLogRow, sendLogRows } from "@whytide/linkedin";
import { EVERY_ROW_SINCE_MS } from "./constants.ts";
import { isAction } from "./sends.ts";

/**
 * A duplicate: the step, and the log rows (`sal_`) that went out for it, or, for a key several steps
 * hold, the other steps (`sx_`), oldest first.
 */
export type Duplicate = { readonly stepExecutionId: string; readonly rows: readonly string[] };
/** A succeeded step as the key check reads it. */
export type KeyedStep = {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly executedAt: Date | null;
};

/** The period's duplicates: by the log's rows, then by the steps' keys (the file's header). */
export async function duplicateSends(period: { readonly since: Date }): Promise<Duplicate[]> {
  const rows = await sendLogRows({ since: new Date(EVERY_ROW_SINCE_MS) });
  const steps = await tenantClient.stepExecution.findMany({
    where: { status: "succeeded" },
    orderBy: [{ executedAt: "asc" }, { id: "asc" }],
    select: { id: true, idempotencyKey: true, executedAt: true },
  });
  return [...duplicateRows(rows, period.since), ...sharedKeys(steps, period.since)];
}

/**
 * The steps with more than one `ok` invite or message row, one of them at or after `since`, in the
 * order of their first row. The rows come oldest first, as linkedin's sendLogRows gives them.
 */
export function duplicateRows(rows: readonly SendLogRow[], since: Date): Duplicate[] {
  const byStep = new Map<string, SendLogRow[]>();
  for (const row of rows) {
    if (row.stepExecutionId === null || !isAction(row)) continue;
    byStep.set(row.stepExecutionId, [...(byStep.get(row.stepExecutionId) ?? []), row]);
  }
  return [...byStep]
    .filter(([, held]) => held.length > 1 && held.some(({ at }) => at >= since))
    .map(([stepExecutionId, held]) => ({ stepExecutionId, rows: held.map(({ id }) => id) }));
}

/**
 * The keys held by more than one succeeded step, one of them executed at or after `since`: the first
 * step, with the others. The steps come oldest first.
 */
export function sharedKeys(steps: readonly KeyedStep[], since: Date): Duplicate[] {
  const byKey = new Map<string, KeyedStep[]>();
  for (const step of steps) {
    byKey.set(step.idempotencyKey, [...(byKey.get(step.idempotencyKey) ?? []), step]);
  }
  return [...byKey.values()].flatMap(([first, ...others]) => {
    if (first === undefined || others.length === 0) return [];
    const inPeriod = [first, ...others].some(
      ({ executedAt }) => executedAt !== null && executedAt >= since,
    );
    return inPeriod ? [{ stepExecutionId: first.id, rows: others.map(({ id }) => id) }] : [];
  });
}
