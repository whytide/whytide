// messaging's workflows, run in Temporal's sandbox (README.md "The workflow"): ids in, statuses and
// counts out. The draft's: the writer makes up to six model calls, so its start-to-close is five
// minutes; its gates' and the model's failures are results; a writer that failed past its attempts
// (a fault) marks the draft failed, write_failed, and fails the workflow. The sweep's, global and
// hourly: every workspace one after the other; one whose sweep failed past its attempts is counted
// and the others go on.
import { isCancellation, proxyActivities } from "@temporalio/workflow";
import type { ActivityFunctions } from "@whytide/platform";
import type { z } from "zod";
import type { DraftStatus } from "../domain/drafts/write.ts";
import { DRAFT_TIMEOUTS, SWEEP } from "./constants.ts";
import type { activities, draftInput } from "./index.ts";

type Activities = ActivityFunctions<typeof activities>;
const { messaging_write_draft } = proxyActivities<Activities>({
  startToCloseTimeout: DRAFT_TIMEOUTS.write,
});
const { messaging_draft_failed } = proxyActivities<Activities>({
  startToCloseTimeout: DRAFT_TIMEOUTS.mark,
});
const { messaging_list_workspaces, messaging_sweep_workspace } = proxyActivities<Activities>({
  startToCloseTimeout: SWEEP.timeout,
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

/** The drafts it failed, and the workspaces whose sweep failed past its attempts. */
export async function messaging_sweep(
  input: Record<string, never>,
): Promise<{ stuck: number; unswept: number }> {
  const { workspaceIds } = await messaging_list_workspaces(input);
  let stuck = 0;
  let unswept = 0;
  for (const workspaceId of workspaceIds) {
    try {
      stuck += (await messaging_sweep_workspace({ workspaceId })).stuck;
    } catch (error) {
      if (isCancellation(error)) throw error;
      unswept += 1;
    }
  }
  return { stuck, unswept };
}
