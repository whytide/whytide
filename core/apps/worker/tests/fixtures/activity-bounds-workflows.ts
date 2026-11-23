// The bundle entry of tests/activity-bounds.test.ts, run in Temporal's sandbox with the host's
// interceptor. bounds_probe calls one activity by its name, with `retry` unset as every module's
// workflow leaves it, and answers the code it finally failed with, or none. bounds_history grows its
// history in batches, each of local activities, one marker apiece, then one activity, whose answer
// starts a workflow task carrying Temporal's hint (a timer would wait about a second on the stack's
// Temporal), until Temporal suggests continuing as new, then for a few batches more, where a second
// report would show; it answers its id and whether Temporal suggested it.
import {
  ActivityFailure,
  ApplicationFailure,
  proxyActivities,
  proxyLocalActivities,
  workflowInfo,
} from "@temporalio/workflow";

type Probe = {
  readonly activity: string;
  readonly input: Record<string, unknown>;
  readonly startToCloseMs: number;
};

export async function bounds_probe({ activity, input, startToCloseMs }: Probe) {
  const activities = proxyActivities<Record<string, (input: unknown) => Promise<unknown>>>({
    startToCloseTimeout: startToCloseMs,
  });
  try {
    await activities[activity]?.(input);
    return { code: null };
  } catch (error) {
    if (!(error instanceof ActivityFailure && error.cause instanceof ApplicationFailure))
      throw error;
    return { code: error.cause.type ?? null };
  }
}

type Growth = { readonly marks: number; readonly most: number; readonly after: number };
type Steps = { bounds_mark(): Promise<null>; bounds_tick(): Promise<null> };
const { bounds_mark } = proxyLocalActivities<Steps>({ startToCloseTimeout: "10 seconds" });
const { bounds_tick } = proxyActivities<Steps>({ startToCloseTimeout: "10 seconds" });

export async function bounds_history({ marks, most, after }: Growth) {
  const batch = async () => {
    await Promise.all(Array.from({ length: marks }, () => bounds_mark()));
    await bounds_tick();
  };
  for (let done = 0; done < most && !workflowInfo().continueAsNewSuggested; done++) await batch();
  for (let done = 0; done < after; done++) await batch();
  const { workflowId, continueAsNewSuggested: suggested, historyLength } = workflowInfo();
  return { workflowId, suggested, historyLength };
}
