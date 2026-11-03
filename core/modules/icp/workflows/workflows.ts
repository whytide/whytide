// The draft's workflow, run in Temporal's sandbox (README "The draft"): ids in, the drafter's result
// out. An answer that failed its schema or its gate twice is a result, ai_failed; a drafter that
// failed past its attempts (the model's port, the database) marks the run failed, draft_failed, and
// fails the workflow.
import { isCancellation, proxyActivities } from "@temporalio/workflow";
import type { ActivityFunctions } from "@whytide/platform";
import type { DraftResult, DraftRun } from "../domain/draft.ts";
import { DRAFT_TIMEOUTS } from "./constants.ts";
import type { activities } from "./index.ts";

type Activities = ActivityFunctions<typeof activities>;
const { icp_draft_from_sources } = proxyActivities<Activities>({
  startToCloseTimeout: DRAFT_TIMEOUTS.draft,
});
const { icp_draft_failed } = proxyActivities<Activities>({
  startToCloseTimeout: DRAFT_TIMEOUTS.mark,
});

export async function icp_draft_profile(input: DraftRun): Promise<DraftResult> {
  try {
    return await icp_draft_from_sources(input);
  } catch (error) {
    if (isCancellation(error)) throw error;
    await icp_draft_failed(input);
    throw error;
  }
}
