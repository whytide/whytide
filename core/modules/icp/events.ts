// The events this module publishes, written to the outbox in the same transaction as the change
// (docs/rules/coding.md §2, §3; core/packages/platform/README.md "Events and the outbox"), its own
// subscriber, which starts a draft's workflow in the worker (platform README "Workflows"), and
// onboarding's company_knowledge_updated, which drafts the empty default (README "The automatic
// draft"). The worker runs each handler in a delivery transaction of its own for the event's
// workspace, at least once: the row lock and the draft's status make a second delivery start nothing.
import { events as onboarding } from "@whytide/onboarding";
import { currentTenant, defineEvents, startWorkflow, subscribe } from "@whytide/platform";
import { z } from "zod";
import { draftAutomatically } from "./domain/auto-draft.ts";
import type { DraftRun } from "./domain/draft.ts";

export const events = defineEvents({
  /**
   * A targeting field of the default audience changed: `version` is its new one, so leads scored
   * before can be re-scored. Another audience's change publishes icp.audience_updated alone.
   */
  "icp.updated": z.strictObject({ workspaceId: z.string(), version: z.number().int().positive() }),
  /** A targeting field of audience `icpId` changed, the default's included: `version` is its new one. */
  "icp.audience_updated": z.strictObject({
    workspaceId: z.string(),
    icpId: z.string(),
    version: z.number().int().positive(),
  }),
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

// The payload's version is not read: the delivery reads the Company Knowledge as it is now.
subscribe(onboarding["onboarding.company_knowledge_updated"], async () => {
  await draftAutomatically();
});
