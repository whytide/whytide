// privacy's workflow, run in Temporal's sandbox (README.md "The 30-day rule"): privacy_retention,
// global and daily, runs each workspace's deletions as of one cutoff, its run's start time less
// RETENTION_NEVER_CONTACTED_DAYS days, then, RETENTION_SWEEP_DELAY_MINUTES after a run that deleted
// anyone, the sweep over the ids deleted. Ids, the cutoff and counts in and out.
import { isCancellation, proxyActivities, sleep, workflowInfo } from "@temporalio/workflow";
import type { ActivityFunctions } from "@whytide/platform";
import { cutoffOf } from "../domain/retention/candidates.ts";
import { MS_PER_MINUTE, RETENTION_SWEEP_DELAY_MINUTES } from "../domain/retention/constants.ts";
import { HEARTBEAT_TIMEOUT, LIST_TIMEOUT, RUN_TIMEOUT, SWEEP_TIMEOUT } from "./constants.ts";
import type { activities } from "./index.ts";

type Activities = ActivityFunctions<typeof activities>;
const { privacy_retention_workspaces } = proxyActivities<Activities>({
  startToCloseTimeout: LIST_TIMEOUT,
});
const { privacy_retention_run } = proxyActivities<Activities>({
  startToCloseTimeout: RUN_TIMEOUT,
  heartbeatTimeout: HEARTBEAT_TIMEOUT,
});
const { privacy_retention_sweep } = proxyActivities<Activities>({
  startToCloseTimeout: SWEEP_TIMEOUT,
  heartbeatTimeout: HEARTBEAT_TIMEOUT,
});

/** What a day's run did, counted: the workspaces' sums, and the rows the sweep erased again. */
export type RetentionResult = {
  readonly workspaces: number;
  readonly candidates: number;
  readonly deleted: number;
  readonly skipped: number;
  readonly failed: number;
  readonly workspacesFailed: number;
  readonly swept: number;
  readonly sweepFailed: number;
};

/**
 * Every workspace's run, one after the other, as of the same cutoff; a workspace that fails past its
 * attempts leaves the others, and the workflow fails with its failure once the sweep has run.
 */
export async function privacy_retention(_input: Record<string, never>): Promise<RetentionResult> {
  const cutoff = cutoffOf(workflowInfo().runStartTime).toISOString();
  const { workspaceIds } = await privacy_retention_workspaces({});
  const totals = { candidates: 0, deleted: 0, skipped: 0, failed: 0, workspacesFailed: 0 };
  const deleted: { workspace: string; personIds: string[] }[] = [];
  let failure: unknown;
  for (const workspace of workspaceIds) {
    try {
      const run = await privacy_retention_run({ workspace, cutoff });
      totals.candidates += run.candidates;
      totals.deleted += run.deleted;
      totals.skipped += run.skipped;
      totals.failed += run.failed;
      if (run.deletedIds.length > 0) deleted.push({ workspace, personIds: [...run.deletedIds] });
    } catch (error) {
      if (isCancellation(error)) throw error;
      totals.workspacesFailed += 1;
      failure ??= error;
    }
  }
  // A batch or a draft in flight for a deleted person may still write a row for the id: the sweep
  // waits for them, then runs the erasers again.
  if (deleted.length > 0) await sleep(RETENTION_SWEEP_DELAY_MINUTES * MS_PER_MINUTE);
  const sum = { workspaces: workspaceIds.length, ...totals };
  const swept = await privacy_retention_sweep({ deleted, totals: sum });
  if (failure !== undefined) throw failure;
  const rows = Object.values(swept.rows).reduce((all, n) => all + n, 0);
  return { ...sum, swept: rows, sweepFailed: swept.failed };
}
