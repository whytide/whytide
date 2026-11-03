// The withdrawal job's tick (README.md "Withdrawals"): once a day, one campaigns_withdraw per
// workspace of tenancy's list, by an id that names the day in WITHDRAW_ZONE, one run of it at a
// time: a start while it runs starts none, and a run after it closed opens no second withdrawal.
import { quotaDay, startWorkflow, type WorkflowStart } from "@whytide/platform";
import { listWorkspaceIds } from "@whytide/tenancy";
import { WITHDRAW_ZONE } from "./constants.ts";

/** The workspace's run of the day of `at`: `campaigns.withdraw:<workspaceId>:<YYYY-MM-DD>`. */
export function withdrawStart(workspaceId: string, at: Date): WorkflowStart {
  return {
    workflow: "campaigns_withdraw",
    input: { workspaceId },
    workflowId: `campaigns.withdraw:${workspaceId}:${quotaDay(at, WITHDRAW_ZONE)}`,
    oneAtATime: true,
  };
}

/**
 * Tenancy's workspaces, each one's run of the day of `at` started. One that fails leaves the others
 * started, and the tick then fails with its code.
 */
export async function startWithdrawals(at: Date): Promise<{ workspaces: number; started: number }> {
  // Tenancy's list: no module reads another's tables (decisions.md, 2026-10-22).
  const workspaceIds = await listWorkspaceIds();
  const failures: unknown[] = [];
  let started = 0;
  for (const workspaceId of workspaceIds) {
    try {
      if ((await startWorkflow(withdrawStart(workspaceId, at))).started) started += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
  return { workspaces: workspaceIds.length, started };
}
