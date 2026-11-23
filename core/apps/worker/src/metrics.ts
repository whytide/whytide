// The worker host's metrics (README "Metrics"): workflow starts by trigger (a schedule's fire or a
// start), runs by outcome and runs whose history grew long, all through the sink of
// workflow-interceptors.ts; activity failures by code; its health, 1 while GET /health would
// answer ok, else 0; and its alerts to the team channel by outcome (alerts.ts).
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
    "worker.workflow.history_long": {
      kind: "counter",
      labels: ["workflow"],
      unit: "{run}",
      description:
        "Workflow runs whose history Temporal suggests continuing as new, by workflow, once per run",
    },
    "worker.activity.failures": {
      kind: "counter",
      labels: ["activity", "code"],
      unit: "{attempt}",
      description: "Activity attempts that failed, by activity and error code",
    },
    "worker.alerts": {
      kind: "counter",
      labels: ["outcome"],
      unit: "{alert}",
      description:
        "Alerts to the team channel, by outcome (sent, repeated, dropped from a full queue, failed after its attempts)",
    },
    "worker.health": {
      kind: "gauge",
      labels: [],
      description: "1 while Temporal answers and the worker runs, as GET /health reports; else 0",
    },
  },
  import.meta.url,
);
