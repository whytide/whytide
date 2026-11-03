// An import's run, in Temporal's sandbox (README "POST …/imports/{job}/run"): ids in, the counts out.
// The rows' activity may take an hour for 50,000 rows; the host's wrapper heartbeats every 20 seconds,
// so a lost worker's attempt is retried within a minute and goes on after the last committed chunk.
// Past its attempts the job ends failed with the failure's code, and the workflow fails with it.
import {
  ActivityFailure,
  ApplicationFailure,
  isCancellation,
  proxyActivities,
} from "@temporalio/workflow";
import type { ActivityFunctions } from "@whytide/platform";
import type { ImportRunResult } from "../domain/import/run.ts";
import type { activities } from "./index.ts";

type Activities = ActivityFunctions<typeof activities>;
const { discovery_import_rows } = proxyActivities<Activities>({
  startToCloseTimeout: "1 hour",
  heartbeatTimeout: "1 minute",
});
const { discovery_import_failed } = proxyActivities<Activities>({
  startToCloseTimeout: "30 seconds",
});

export async function discovery_import_run(input: {
  workspaceId: string;
  jobId: string;
}): Promise<ImportRunResult> {
  try {
    return await discovery_import_rows(input);
  } catch (error) {
    if (isCancellation(error)) throw error;
    // The host's wrapper fails an activity with its code as the failure's type.
    const cause = error instanceof ActivityFailure ? error.cause : undefined;
    const code = cause instanceof ApplicationFailure && cause.type ? cause.type : "import_failed";
    await discovery_import_failed({ ...input, code });
    throw error;
  }
}
