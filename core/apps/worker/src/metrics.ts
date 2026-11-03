// The worker host's metrics (README "Metrics"): workflow starts by trigger (a schedule's fire or a
// start) and runs by outcome, both through the sink of workflow-interceptors.ts; activity failures
// by code; and its health, 1 while GET /health would answer ok, else 0.
import { defineMetrics } from "@whytide/platform";

export const workerMetrics = defineMetrics(
  {
    "worker.workflow.starts": {
      kind: "counter",
      labels: ["workflow", "trigger"],
      unit: "{run}",
      description:
        "Workflow runs started on this worker, by workflow and trigger (schedule, start)",
    },
    "worker.workflow.runs": {
      kind: "counter",
      labels: ["workflow", "outcome"],
      unit: "{run}",
      description:
        "Workflow runs ended, by workflow and outcome (completed, failed, cancelled, continued)",
    },
    "worker.activity.failures": {
      kind: "counter",
      labels: ["activity", "code"],
      unit: "{attempt}",
      description: "Activity attempts that failed, by activity and error code",
    },
    "worker.health": {
      kind: "gauge",
      labels: [],
      description: "1 while Temporal answers and the worker runs, as GET /health reports; else 0",
    },
  },
  import.meta.url,
);
