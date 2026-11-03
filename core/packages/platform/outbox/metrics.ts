// The outbox's metrics (README "Events and the outbox", "Metrics"): the counters deliverPending
// adds to, and the two gauges recordOutboxStats sets from the store.
import { defineMetrics } from "../telemetry/metrics.ts";

export const outboxMetrics = defineMetrics(
  {
    "outbox.dead_letters": {
      kind: "counter",
      labels: ["event"],
      unit: "{row}",
      description: "Outbox rows dead-lettered after their last delivery attempt",
    },
    "outbox.unhandled": {
      kind: "counter",
      labels: ["event"],
      unit: "{row}",
      description: "Outbox rows marked delivered with no subscriber for their event",
    },
    "outbox.dead_rows": {
      kind: "gauge",
      labels: [],
      unit: "{row}",
      description: "Dead-lettered rows waiting for replayDeadLetter, in every workspace",
    },
    "outbox.lag": {
      kind: "gauge",
      labels: [],
      unit: "s",
      description: "How long the oldest due row has waited for its delivery",
    },
  },
  import.meta.url,
);
