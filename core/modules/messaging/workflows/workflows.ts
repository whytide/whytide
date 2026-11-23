// messaging's workflows, run in Temporal's sandbox (README.md "The workflow"): ids in, statuses and
// counts out. The draft's: the writer makes up to six model calls, so its start-to-close is five
// minutes; its gates' and the model's failures are results; a writer that failed past its attempts
// (a fault) marks the draft failed, write_failed, and fails the workflow. The sweep's, global and
// hourly: every workspace one after the other; one whose sweep failed past its attempts is counted
// and the others go on; behind SWEEP_PAGES_PATCH, a run takes one page of workspaces and continues
// as new with its cursor and counts until the last page (gamma-p0-085).
import { continueAsNew, isCancellation, patched, proxyActivities } from "@temporalio/workflow";
import type { ActivityFunctions } from "@whytide/platform";
import type { z } from "zod";
import type { DraftStatus } from "../domain/drafts/write.ts";
import { DRAFT_TIMEOUTS, SWEEP, SWEEP_PAGES_PATCH } from "./constants.ts";
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
export type SweepCounts = { readonly stuck: number; readonly unswept: number };

/** Continued as new, a run's cursor, the last workspace swept, and its counts so far. */
export type SweepInput = { readonly afterId?: string; readonly counts?: SweepCounts };

export async function messaging_sweep(input: SweepInput): Promise<SweepCounts> {
  // Asked once, at the run's start, as linkedin_status_refresh asks its patches: a run started
  // before the patch replays without its marker, lists its workspaces once, as before, and never
  // continues as new.
  const paged = patched(SWEEP_PAGES_PATCH);
  const page = paged ? { afterId: input.afterId } : input;
  const { workspaceIds, next } = await messaging_list_workspaces(page);
  let { stuck, unswept } = input.counts ?? { stuck: 0, unswept: 0 };
  for (const workspaceId of workspaceIds) {
    try {
      stuck += (await messaging_sweep_workspace({ workspaceId })).stuck;
    } catch (error) {
      if (isCancellation(error)) throw error;
      unswept += 1;
    }
  }
  // After a page that is not the last, the next run of the same id goes on after its last
  // workspace, so that no run's history grows with the number of workspaces.
  if (paged && typeof next === "string") {
    return continueAsNew<typeof messaging_sweep>({ afterId: next, counts: { stuck, unswept } });
  }
  return { stuck, unswept };
}
