// What the worker host loads of credits (core/apps/worker/README.md "Modules"; README "Periods",
// "Alerts"): the daily workflow credits_period, global, with no workspace in its input, its activity
// credits_grant_periods and its schedule; the workflow credits_alerts, global too, its check, its
// mail, the tries of a mail that failed, and its schedule every CREDIT_ALERT_CHECK_MINUTES; and
// onWorkerStart, which binds the credits client before the worker polls, so that a module's activity
// can reserve in its tenant run, and keeps the host's logger for the activities' lines.
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
import { z } from "zod";
import { checkAlerts } from "../domain/alerts/check.ts";
import { CREDIT_ALERT_CHECK_MINUTES } from "../domain/alerts/constants.ts";
import { failAlert, mailAlert } from "../domain/alerts/mail.ts";
import { creditsClient } from "../domain/client.ts";
import { grantPeriods } from "../domain/seed.ts";

let log: Logger | undefined;
const logger = () => (log ??= createLogger());

/** The check's instant: the workflow's start, which a test may give. */
const at = z.iso.datetime();
/** One alert to mail, by its id. */
const alertInput = globalWorkflowInput.extend({ alertId: z.string().min(1).max(64) });

export const workflows = defineWorkflows({
  credits_period: { input: globalWorkflowInput, taskQueue: DEFAULT_TASK_QUEUE, scope: "global" },
  credits_alerts: {
    input: globalWorkflowInput.extend({ at: at.optional() }),
    taskQueue: DEFAULT_TASK_QUEUE,
    scope: "global",
  },
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
      logger().info(fields, "credits: the periods are granted");
      return counts;
    },
  }),
  /** The thresholds reached as of `at`, recorded once, and the alerts to mail; counts are logged. */
  credits_check_alerts: defineActivity({
    kind: "db",
    scope: "global",
    input: globalWorkflowInput.extend({ at }),
    run: async (input) => {
      const checked = await checkAlerts(new Date(input.at));
      const fields = {
        organization_count: checked.organizations,
        recorded_count: checked.recorded,
        alert_count: checked.alertIds.length,
      };
      logger().info(fields, "credits: the alerts are checked");
      return checked;
    },
  }),
  /** One alert's mail to its organization's Owners, each once, on the provider kind's attempts. */
  credits_mail_alert: defineActivity({
    kind: "provider",
    scope: "global",
    input: alertInput,
    run: (input) => mailAlert(input.alertId, { log: logger() }),
  }),
  /** One alert's tries raised once its mail failed its attempts, a timeout's included: the rows. */
  credits_fail_alert: defineActivity({
    kind: "db",
    scope: "global",
    input: alertInput,
    run: async (input) => ({ rows: await failAlert(input.alertId, { log: logger() }) }),
  }),
};

/** Daily at 00:05 UTC: a period is granted once, so a worker down on the 1st grants it the next day. */
const daily = { cronExpressions: ["5 0 * * *"], timezone: "UTC" };
/** Every CREDIT_ALERT_CHECK_MINUTES; Temporal's default overlap policy skips a check while one runs. */
const every = `${CREDIT_ALERT_CHECK_MINUTES} minutes`;
export const schedules = defineSchedules([
  { id: "period", workflow: "credits_period", spec: daily, input: {} },
  { id: "alerts", workflow: "credits_alerts", spec: { intervals: [{ every }] }, input: {} },
]);

export async function onWorkerStart(context: { readonly log: Logger }): Promise<void> {
  bindCreditsClient(creditsClient);
  log = context.log;
}
