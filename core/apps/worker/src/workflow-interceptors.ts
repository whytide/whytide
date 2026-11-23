// The interceptor of every workflow the worker runs (README "Metrics"), bundled into Temporal's
// sandbox: through the `metrics` sink it tells the host that a run started and how it ended, and the
// host counts both (temporal.ts). Sinks are not called while a history replays, so a run counts once.
// It also tells the host, once per run, that the run's history is long enough for Temporal to suggest
// continuing as new (docs/workflows.md "Long loops"): the factory runs once per run, so its flag is
// the run's, and a replay sets it again where the run first saw the suggestion, without the sink.
// A failed run's end carries its failure's code, from which the host raises an alert (README
// "Alerts"): an ApplicationFailure's type, an activity's or a child's cause's, else the class's name.
// Never its message.
import {
  ActivityFailure,
  ApplicationFailure,
  ChildWorkflowFailure,
  ContinueAsNew,
  isCancellation,
  proxySinks,
  type Sinks,
  type WorkflowInterceptorsFactory,
  workflowInfo,
} from "@temporalio/workflow";

export type WorkflowOutcome = "completed" | "failed" | "cancelled" | "continued";
export interface MetricsSinks extends Sinks {
  metrics: {
    started(): void;
    /** `failure`, a failed run's: its code or its failure's type. */
    ended(outcome: WorkflowOutcome, failure?: string): void;
    historyLong(): void;
  };
}

const { metrics } = proxySinks<MetricsSinks>();

export const interceptors: WorkflowInterceptorsFactory = () => {
  let toldLong = false;
  return {
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
            else if (isCancellation(error)) metrics.ended("cancelled");
            else metrics.ended("failed", failureOf(error));
            throw error;
          }
        },
      },
    ],
    internals: [
      {
        // Every activation, before its jobs: workflowInfo() holds the WorkflowTaskStarted's hint.
        activate(input, next) {
          if (!toldLong && workflowInfo().continueAsNewSuggested) {
            toldLong = true;
            metrics.historyLong();
          }
          next(input);
        },
      },
    ],
  };
};

/** A failed run's code: its ApplicationFailure's type, its activity's or child's cause's, else the class. */
function failureOf(error: unknown): string {
  const cause =
    error instanceof ActivityFailure || error instanceof ChildWorkflowFailure ? error.cause : error;
  if (cause instanceof ApplicationFailure && cause.type) return cause.type;
  return cause instanceof Error ? cause.name : typeof cause;
}
