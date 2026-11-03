// linkedin's metrics (core/packages/platform/README.md "Metrics"): the action-log rows of linkedin's
// own activities, by kind and outcome, each adding its count once its run has committed
// (domain/action-log/log.ts countAction); the provider's events the receiver dropped, by kind; and the
// account warnings it received, by status; the health changes, by the state each moved to and its
// trigger. No label carries an account, a post, a person or a ref.
import { defineMetrics } from "@whytide/platform";

export const linkedinMetrics = defineMetrics(
  {
    "linkedin.actions": {
      kind: "counter",
      labels: ["kind", "outcome"],
      unit: "{action}",
      description:
        "Sender-account actions logged by linkedin's activities, by kind and outcome, each adding its count once its run commits: reads made, sends, status checks",
    },
    "linkedin.events_dropped": {
      kind: "counter",
      labels: ["kind"],
      unit: "{event}",
      description:
        "Provider events dropped at intake, by kind: of a kind the port does not know, or about no person an account of ours invited or messaged",
    },
    "linkedin.account_warnings": {
      kind: "counter",
      labels: ["status"],
      unit: "{event}",
      description:
        "Account status events of a warning, checkpoint or restricted, received: each pauses the accounts it names (domain/health/)",
    },
    "linkedin.health_changes": {
      kind: "counter",
      labels: ["status", "trigger"],
      unit: "{change}",
      description:
        "Changes of a sender account's health, by the state it moved to (status) and the trigger, counted in the run of their cause",
    },
  },
  import.meta.url,
);
