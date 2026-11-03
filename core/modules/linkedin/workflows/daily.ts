// The daily job's activities (README.md "Worker"; docs/flows.md "The daily job"). linkedin_daily,
// global, by the schedule linkedin.daily: linkedin_daily_tick starts one linkedin_daily_workspace per
// workspace, then linkedin_purge_receipts deletes the receipts past EVENT_RECEIPT_DAYS. Each
// workspace's run: linkedin_ramp_accounts ramps each sender account in a tenant run of its own,
// linkedin_expire_holds expires the reservations past their hold that no reservation swept, and
// linkedin_purge_action_log deletes its action log past ACTION_LOG_DAYS. Ids in, counts out. A
// failure leaves the other workspaces and accounts going on; the activity then fails with its code.
import type { TenantClient } from "@whytide/db";
import {
  type ActivityContext,
  defineActivity,
  globalWorkflowInput,
  quotaDay,
  startWorkflow,
  type WorkflowStart,
  workflowInput,
} from "@whytide/platform";
import { listWorkspaceIds } from "@whytide/tenancy";
import { now } from "../domain/clock.ts";
import { accountIds, rampAccount } from "../domain/ramp/account.ts";
import { purgeActionLog, purgeReceipts } from "../domain/retention/purge.ts";
import { expireStale, staleDays } from "../domain/retention/stale-holds.ts";
import { DAILY_ZONE } from "./constants.ts";

type Context = ActivityContext<TenantClient>;

/**
 * The start of the workspace's run of the day, `linkedin.daily:<workspaceId>:<date in DAILY_ZONE>`,
 * one run of the id at a time: a start while it runs starts none, one after it closed runs it again,
 * which changes nothing the same day.
 */
export function dailyStart(workspaceId: string, at: Date): WorkflowStart {
  return {
    workflow: "linkedin_daily_workspace",
    input: { workspaceId },
    workflowId: `linkedin.daily:${workspaceId}:${quotaDay(at, DAILY_ZONE)}`,
    oneAtATime: true,
  };
}

/** Every workspace's run of the day started, from tenancy's ids; the counts. */
async function startDailyRuns(): Promise<{ workspaces: number; started: number }> {
  // Tenancy's list: no module reads another's tables (decisions.md, 2026-10-22).
  const workspaceIds = await listWorkspaceIds();
  const at = now();
  const failures: unknown[] = [];
  let started = 0;
  for (const workspaceId of workspaceIds) {
    try {
      if ((await startWorkflow(dailyStart(workspaceId, at))).started) started += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
  return { workspaces: workspaceIds.length, started };
}

/** Each of the workspace's accounts ramped in a run of its own, at one instant; the counts. */
async function rampAccounts(context: Context): Promise<{ accounts: number; ramped: number }> {
  const at = now();
  const ids = await context.tenant(() => accountIds());
  const failures: unknown[] = [];
  let ramped = 0;
  for (const accountId of ids) {
    try {
      if ((await context.tenant(() => rampAccount(accountId, at))) !== null) ramped += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
  return { accounts: ids.length, ramped };
}

/** The workspace's days with a reservation past its hold, each swept in its own run; the count. */
async function expireHolds(context: Context): Promise<{ days: number }> {
  const at = now();
  const days = await context.tenant(() => staleDays(at));
  for (const usageId of days) await context.tenant(() => expireStale(usageId, at));
  return { days: days.length };
}

export const dailyActivities = {
  /** linkedin_daily's: every workspace's run of the day started; the counts. */
  linkedin_daily_tick: defineActivity({
    kind: "db",
    scope: "global",
    input: globalWorkflowInput,
    run: startDailyRuns,
  }),
  /** linkedin_daily's: the receipts past EVENT_RECEIPT_DAYS deleted, outside any run; the count. */
  linkedin_purge_receipts: defineActivity({
    kind: "db",
    scope: "global",
    input: globalWorkflowInput,
    run: async () => ({ deleted: await purgeReceipts(now()) }),
  }),
  linkedin_ramp_accounts: defineActivity<
    typeof workflowInput,
    { accounts: number; ramped: number },
    TenantClient
  >({
    kind: "db",
    input: workflowInput,
    run: (_input, context) => rampAccounts(context),
  }),
  linkedin_expire_holds: defineActivity<typeof workflowInput, { days: number }, TenantClient>({
    kind: "db",
    input: workflowInput,
    run: (_input, context) => expireHolds(context),
  }),
  /** The workspace's action log past ACTION_LOG_DAYS deleted, a batch per run; the count. */
  linkedin_purge_action_log: defineActivity<
    typeof workflowInput,
    { deleted: number },
    TenantClient
  >({
    kind: "db",
    input: workflowInput,
    run: async (_input, context) => ({ deleted: await purgeActionLog(context.tenant, now()) }),
  }),
};
