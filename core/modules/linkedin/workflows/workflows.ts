// linkedin's workflows, run in Temporal's sandbox (README.md "Worker"): ids in, statuses and counts
// out. linkedin_refresh_account refreshes one account, on a Refresh status press;
// linkedin_status_refresh, hourly and global, every account with a reference, workspace by workspace
// and one after the other, then its pending invitations' check, due once a day (the patch
// PENDING_INVITES_PATCH, asked once at the run's start): an account whose refresh or check failed
// past its attempts is counted and the others go on. linkedin_daily, daily and global, starts each
// workspace's linkedin_daily_workspace and purges the receipts; a workspace's run ramps its accounts,
// expires the stale holds and purges its action log. A failed step leaves the purge after it to run,
// then fails the run with its code.
// linkedin_notify mails the owner about one health event, or the operator about the fleet breaker's
// trip, once (domain/health/mail.ts).
import { isCancellation, patched, proxyActivities } from "@temporalio/workflow";
import type { ActivityFunctions } from "@whytide/platform";
import {
  DAILY_TIMEOUT,
  INVITES_CHECK_TIMEOUT,
  NOTIFY_TIMEOUT,
  PENDING_INVITES_PATCH,
} from "./constants.ts";
import type { dailyActivities } from "./daily.ts";
import type { activities } from "./index.ts";

const { linkedin_list_referenced_accounts, linkedin_list_workspaces, linkedin_refresh_status } =
  proxyActivities<ActivityFunctions<typeof activities>>({ startToCloseTimeout: "1 minute" });
const daily = proxyActivities<ActivityFunctions<typeof dailyActivities>>({
  startToCloseTimeout: DAILY_TIMEOUT,
});
const { linkedin_mail_health } = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: NOTIFY_TIMEOUT,
});
const { linkedin_check_invites } = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: INVITES_CHECK_TIMEOUT,
});

export async function linkedin_refresh_account(input: { workspaceId: string; accountId: string }) {
  return linkedin_refresh_status(input);
}

export async function linkedin_status_refresh(input: Record<string, never>) {
  // Asked once, here: a run started before the patch replays without its marker and checks no
  // invitations to its end, where a later ask, live once the replay is over, would turn it on mid-run.
  const checksInvites = patched(PENDING_INVITES_PATCH);
  const { workspaceIds } = await linkedin_list_workspaces(input);
  let accounts = 0;
  let failed = 0;
  for (const workspaceId of workspaceIds) {
    const { accountIds } = await linkedin_list_referenced_accounts({ workspaceId });
    for (const accountId of accountIds) {
      accounts += 1;
      try {
        await linkedin_refresh_status({ workspaceId, accountId });
        if (checksInvites) await linkedin_check_invites({ workspaceId, accountId });
      } catch (error) {
        if (isCancellation(error)) throw error;
        failed += 1;
      }
    }
  }
  return { accounts, failed };
}

/** The day's job: each workspace's run started, then the receipts past their days deleted. */
export async function linkedin_daily(
  input: Record<string, never>,
): Promise<{ workspaces: number; started: number; receiptsDeleted: number }> {
  const ticked = await settled(daily.linkedin_daily_tick(input));
  const { deleted } = await daily.linkedin_purge_receipts(input);
  if ("failure" in ticked) throw ticked.failure;
  return { ...ticked.value, receiptsDeleted: deleted };
}

/** A workspace's day: its accounts ramped, its stale holds expired, its action log purged. */
export async function linkedin_daily_workspace(input: { workspaceId: string }): Promise<{
  accounts: number;
  ramped: number;
  staleDays: number;
  logDeleted: number;
}> {
  const ramp = await settled(daily.linkedin_ramp_accounts(input));
  const holds = await settled(daily.linkedin_expire_holds(input));
  const { deleted } = await daily.linkedin_purge_action_log(input);
  if ("failure" in ramp) throw ramp.failure;
  if ("failure" in holds) throw holds.failure;
  return { ...ramp.value, staleDays: holds.value.days, logDeleted: deleted };
}

/** A step's value, or its failure, thrown once the purge after it ran; a cancellation at once. */
async function settled<T>(step: Promise<T>): Promise<{ value: T } | { failure: unknown }> {
  try {
    return { value: await step };
  } catch (error) {
    if (isCancellation(error)) throw error;
    return { failure: error };
  }
}

/**
 * The recipient's mail about the health event: sent, or why not (already sent, no owner to mail, no
 * operator's address).
 */
export async function linkedin_notify(input: {
  workspaceId: string;
  healthEventId: string;
  recipient: "owner" | "operator";
}) {
  return linkedin_mail_health(input);
}
