// What the worker host loads of credits (core/apps/worker/README.md "Modules"; README "Periods"): the
// daily workflow credits_period, global, with no workspace in its input, its activity
// credits_grant_periods and its schedule; and onWorkerStart, which binds the credits client before
// the worker polls, so that a module's activity can reserve in its tenant run, and keeps the host's
// logger for the activity's line.
import {
  bindCreditsClient,
  createLogger,
  DEFAULT_TASK_QUEUE,
  defineActivity,
  defineSchedules,
  defineWorkflows,
  globalWorkflowInput,
  type Logger,
} from "@whytide/platform";
import { creditsClient } from "../domain/client.ts";
import { grantPeriods } from "../domain/seed.ts";

let log: Logger | undefined;

export const workflows = defineWorkflows({
  credits_period: { input: globalWorkflowInput, taskQueue: DEFAULT_TASK_QUEUE, scope: "global" },
});

export const activities = {
  /** The current period for every organization with a subscription; the counts only are logged. */
  credits_grant_periods: defineActivity({
    kind: "db",
    scope: "global",
    input: globalWorkflowInput,
    run: async () => {
      const counts = await grantPeriods();
      const fields = { organization_count: counts.organizations, granted_count: counts.granted };
      (log ??= createLogger()).info(fields, "credits: the periods are granted");
      return counts;
    },
  }),
};

/** Daily at 00:05 UTC: a period is granted once, so a worker down on the 1st grants it the next day. */
const daily = { cronExpressions: ["5 0 * * *"], timezone: "UTC" };
export const schedules = defineSchedules([
  { id: "period", workflow: "credits_period", spec: daily, input: {} },
]);

export async function onWorkerStart(context: { readonly log: Logger }): Promise<void> {
  bindCreditsClient(creditsClient);
  log = context.log;
}
