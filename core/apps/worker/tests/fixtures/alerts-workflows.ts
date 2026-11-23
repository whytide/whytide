// The bundle entry of tests/alerts-worker.test.ts, run in Temporal's sandbox with the host's
// interceptor. alerts_probe calls one activity by its name, with `retry` unset as every module's
// workflow leaves it, and answers what reached Temporal of its final failure: the type, the message,
// how many details and whether a cause came with it. alerts_fail fails the run with an
// ApplicationFailure whose message holds a name and an address; alerts_done completes.
import { ActivityFailure, ApplicationFailure, proxyActivities } from "@temporalio/workflow";

type Probe = {
  readonly activity: string;
  readonly input: Record<string, unknown>;
  readonly startToCloseMs: number;
};

export async function alerts_probe({ activity, input, startToCloseMs }: Probe) {
  const activities = proxyActivities<Record<string, (input: unknown) => Promise<unknown>>>({
    startToCloseTimeout: startToCloseMs,
  });
  try {
    await activities[activity]?.(input);
    return { failure: null };
  } catch (error) {
    if (!(error instanceof ActivityFailure && error.cause instanceof ApplicationFailure))
      throw error;
    const { type, message, details, cause } = error.cause;
    return {
      failure: { type, message, details: details?.length ?? 0, cause: cause !== undefined },
    };
  }
}

export async function alerts_fail(_input: Record<string, never>) {
  throw ApplicationFailure.create({
    type: "fixture_failed",
    message: "Ada Lovelace <ada@example.com> https://www.linkedin.com/in/ada",
    nonRetryable: true,
  });
}

export async function alerts_done(_input: Record<string, never>) {
  return "done";
}
