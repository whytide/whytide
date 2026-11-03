// The draft's workflow, run in Temporal's sandbox (README.md "The workflow"): ids in, the draft's
// status out. The writer makes up to six model calls, so its start-to-close is five minutes. Its
// gates' and the model's failures are results; a writer that failed past its attempts (a fault)
// marks the draft failed, write_failed, and fails the workflow.
import { isCancellation, proxyActivities } from "@temporalio/workflow";
import type { ActivityFunctions } from "@whytide/platform";
import type { z } from "zod";
import type { DraftStatus } from "../domain/drafts/write.ts";
import type { activities, draftInput } from "./index.ts";

type Activities = ActivityFunctions<typeof activities>;
const { messaging_write_draft } = proxyActivities<Activities>({
  startToCloseTimeout: "5 minutes",
});
const { messaging_draft_failed } = proxyActivities<Activities>({
  startToCloseTimeout: "10 seconds",
});

export async function messaging_draft_message(
  input: z.input<typeof draftInput>,
): Promise<{ status: DraftStatus }> {
  try {
    return await messaging_write_draft(input);
  } catch (error) {
    if (isCancellation(error)) throw error;
    await messaging_draft_failed(input);
    throw error;
  }
}
