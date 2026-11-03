// The events this module publishes, written to the outbox in the same transaction as the change
// (docs/rules/coding.md §2, §3; core/packages/platform/README.md "Events and the outbox"), and its own
// subscriber, which starts a draft's workflow in the worker (platform README "Workflows").
import { currentTenant, defineEvents, startWorkflow, subscribe } from "@whytide/platform";
import { z } from "zod";
import type { DraftRun } from "./domain/draft.ts";

export const events = defineEvents({
  /** A targeting field changed: `version` is the ICP's new one, so leads scored before can be re-scored. */
  "icp.updated": z.strictObject({ workspaceId: z.string(), version: z.number().int().positive() }),
  /** A draft of the ICP started run `draftRunId` (README "The draft"): the worker starts its workflow. */
  "icp.draft_requested": z.strictObject({
    workspaceId: z.string(),
    icpId: z.string(),
    draftRunId: z.string(),
  }),
});

/** The start of a draft's workflow, by an id from its run: a second delivery starts no second run. */
export function draftStart({ workspaceId, icpId, draftRunId }: DraftRun) {
  return {
    workflow: "icp_draft_profile",
    input: { workspaceId, icpId, draftRunId },
    workflowId: `icp.draft:${workspaceId}:${draftRunId}`,
  };
}

// The workspace is the delivery's tenant run, never the payload's: the starter does not compare them.
subscribe(events["icp.draft_requested"], async (payload) => {
  await startWorkflow(draftStart({ ...payload, workspaceId: currentTenant().workspaceId }));
});
