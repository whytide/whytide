// The interceptor of every workflow the worker runs (README "Metrics"), bundled into Temporal's
// sandbox: through the `metrics` sink it tells the host that a run started and how it ended, and the
// host counts both (temporal.ts). Sinks are not called while a history replays, so a run counts once.
import {
  ContinueAsNew,
  isCancellation,
  proxySinks,
  type Sinks,
  type WorkflowInterceptorsFactory,
} from "@temporalio/workflow";

export type WorkflowOutcome = "completed" | "failed" | "cancelled" | "continued";
export interface MetricsSinks extends Sinks {
  metrics: { started(): void; ended(outcome: WorkflowOutcome): void };
}

const { metrics } = proxySinks<MetricsSinks>();

export const interceptors: WorkflowInterceptorsFactory = () => ({
  inbound: [
    {
      async execute(input, next) {
        metrics.started();
        try {
          const result = await next(input);
          metrics.ended("completed");
          return result;
        } catch (error) {
          if (error instanceof ContinueAsNew) metrics.ended("continued");
          else metrics.ended(isCancellation(error) ? "cancelled" : "failed");
          throw error;
        }
      },
    },
  ],
});
