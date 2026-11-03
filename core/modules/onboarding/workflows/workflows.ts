// The Draft's workflow, run in Temporal's sandbox (README "The website fetch"): ids in, the fetch's
// result out. The fetch keeps its own sixty-second deadline and its start-to-close is a little above
// it, so a stalled site fails inside one attempt; a fetch that failed past its attempts (a fault, not
// a site: the site's failures are results) marks the run failed, fetch_failed, and fails the workflow.
// Then the drafter (README "The drafter"), whose result is the run's: an answer that failed its schema
// or a gate twice is a result, ai_failed; past its attempts, the run is marked failed, draft_failed.
import { isCancellation, proxyActivities } from "@temporalio/workflow";
import type { ActivityFunctions } from "@whytide/platform";
import type { DraftRun, FetchResult, RunResult } from "../domain/draft.ts";
import type { activities } from "./index.ts";

type Activities = ActivityFunctions<typeof activities>;
const { onboarding_fetch_website } = proxyActivities<Activities>({
  startToCloseTimeout: "75 seconds",
  heartbeatTimeout: "30 seconds",
});
const { onboarding_draft_from_pages } = proxyActivities<Activities>({
  startToCloseTimeout: "3 minutes",
});
const { onboarding_fetch_failed, onboarding_draft_failed } = proxyActivities<Activities>({
  startToCloseTimeout: "10 seconds",
});

export async function onboarding_draft_company_knowledge(
  input: DraftRun,
): Promise<FetchResult | RunResult> {
  const fetched = await step(onboarding_fetch_website(input), onboarding_fetch_failed, input);
  if (fetched.status !== "fetched") return fetched;
  return step(onboarding_draft_from_pages(input), onboarding_draft_failed, input);
}

/** The step's result; past its attempts, the run marked failed by `mark`, then the step's error. */
async function step<T>(
  running: Promise<T>,
  mark: (input: DraftRun) => Promise<unknown>,
  input: DraftRun,
): Promise<T> {
  try {
    return await running;
  } catch (error) {
    if (isCancellation(error)) throw error;
    await mark(input);
    throw error;
  }
}
