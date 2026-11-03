// linkedin's workflows, run in Temporal's sandbox (README.md "Worker"): ids in, statuses and counts
// out. linkedin_refresh_account refreshes one account, on a Refresh status press;
// linkedin_status_refresh, hourly and global, every account with a reference, workspace by workspace
// and one after the other: an account whose refresh failed past its attempts is counted and the
// others go on.
import { isCancellation, proxyActivities } from "@temporalio/workflow";
import type { ActivityFunctions } from "@whytide/platform";
import type { activities } from "./index.ts";

const { linkedin_list_referenced_accounts, linkedin_list_workspaces, linkedin_refresh_status } =
  proxyActivities<ActivityFunctions<typeof activities>>({ startToCloseTimeout: "1 minute" });

export async function linkedin_refresh_account(input: { workspaceId: string; accountId: string }) {
  return linkedin_refresh_status(input);
}

export async function linkedin_status_refresh(input: Record<string, never>) {
  const { workspaceIds } = await linkedin_list_workspaces(input);
  let accounts = 0;
  let failed = 0;
  for (const workspaceId of workspaceIds) {
    const { accountIds } = await linkedin_list_referenced_accounts({ workspaceId });
    for (const accountId of accountIds) {
      accounts += 1;
      try {
        await linkedin_refresh_status({ workspaceId, accountId });
      } catch (error) {
        if (isCancellation(error)) throw error;
        failed += 1;
      }
    }
  }
  return { accounts, failed };
}
