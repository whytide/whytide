// credits' workflows, run in Temporal's sandbox (README "Periods", "Alerts"): credits_period, global,
// grants the current period to every organization with a subscription through its one activity;
// credits_alerts, global, checks the organizations' shares as of its start, then mails each alert the
// check answers, one activity each, a failed mail leaving the others to go and raising the alert's
// tries through an activity of its own, whatever ended its attempts (review-gaps-2).
import { ActivityFailure, isCancellation, proxyActivities } from "@temporalio/workflow";
import type { ActivityFunctions } from "@whytide/platform";
import { ALERT_CHECK_TIMEOUT, ALERT_FAIL_TIMEOUT, ALERT_MAIL_TIMEOUT } from "./constants.ts";
import type { activities } from "./index.ts";

type Steps = ActivityFunctions<typeof activities>;
const { credits_grant_periods } = proxyActivities<Steps>({ startToCloseTimeout: "5 minutes" });
const { credits_check_alerts } = proxyActivities<Steps>({
  startToCloseTimeout: ALERT_CHECK_TIMEOUT,
});
const { credits_mail_alert } = proxyActivities<Steps>({ startToCloseTimeout: ALERT_MAIL_TIMEOUT });
const { credits_fail_alert } = proxyActivities<Steps>({ startToCloseTimeout: ALERT_FAIL_TIMEOUT });

export async function credits_period(input: Record<string, never>) {
  return credits_grant_periods(input);
}

/** What a check did, counted: ids and counts only. */
export type AlertsResult = {
  readonly organizations: number;
  readonly recorded: number;
  readonly mailed: number;
  readonly failed: number;
};

/**
 * The check as of `at`, the run's start unless given, then each alert's mail. A mail that failed its
 * attempts, a timeout's included, counts as failed and gets its tries raised, here rather than in
 * the mail's own code, which a timeout never reaches; the next check tries it again.
 */
export async function credits_alerts(input: { at?: string }): Promise<AlertsResult> {
  const at = input.at ?? new Date().toISOString();
  const { organizations, recorded, alertIds } = await credits_check_alerts({ at });
  let mailed = 0;
  let failed = 0;
  for (const alertId of alertIds) {
    try {
      if ((await credits_mail_alert({ alertId })).sent) mailed += 1;
    } catch (error) {
      if (!failedForGood(error)) throw error;
      failed += 1;
      await raiseTries(alertId);
    }
  }
  return { organizations, recorded, mailed, failed };
}

/** An activity's failure past its attempts, whatever ended them; a cancellation is none. */
function failedForGood(error: unknown): boolean {
  return !isCancellation(error) && error instanceof ActivityFailure;
}

/** The alert's tries raised; a raise that fails too leaves the next alerts to go. */
async function raiseTries(alertId: string): Promise<void> {
  try {
    await credits_fail_alert({ alertId });
  } catch (error) {
    if (!failedForGood(error)) throw error;
  }
}
