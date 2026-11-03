// signals' metrics (core/packages/platform/README.md "Metrics"), on the dashboard
// deploy/observability/dashboards/signals.json.
import { defineMetrics } from "@whytide/platform";

export const signalsMetrics = defineMetrics(
  {
    "signals.runs": {
      kind: "counter",
      labels: ["outcome", "code"],
      unit: "{run}",
      description:
        "Signal runs ended, by outcome (done, failed, cancelled) and the failure's code (none otherwise)",
    },
    "signals.candidates": {
      kind: "counter",
      labels: ["kind"],
      unit: "{candidate}",
      description: "Candidates signal runs staged, new to their run, by the source's kind",
    },
  },
  import.meta.url,
);
