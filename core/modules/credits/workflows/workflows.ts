// credits' workflow, run in Temporal's sandbox (README "Periods"): credits_period, global, grants the
// current period to every organization with a subscription through its one activity.
import { proxyActivities } from "@temporalio/workflow";
import type { ActivityFunctions } from "@whytide/platform";
import type { activities } from "./index.ts";

const { credits_grant_periods } = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: "5 minutes",
});

export async function credits_period(input: Record<string, never>) {
  return credits_grant_periods(input);
}
