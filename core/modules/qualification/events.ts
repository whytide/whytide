// The events this module publishes, written to the outbox in the same transaction as the change
// (docs/rules/coding.md §2, §3; core/packages/platform/README.md "Events and the outbox"), and the
// subscriptions: two start the workspace's batch at once (README "The batch"), and its own re-score
// request starts the re-score (README "The re-score").
import { events as discovery } from "@whytide/discovery";
import { events as icp } from "@whytide/icp";
import { currentTenant, defineEvents, startWorkflow, subscribe } from "@whytide/platform";
import { z } from "zod";

export const events = defineEvents({
  /** The batch decided a lead: its status, and its tier when it has one. */
  "qualification.lead_qualified": z.strictObject({
    workspaceId: z.string(),
    personId: z.string(),
    status: z.enum(["hard_filtered", "qualified", "not_qualified", "needs_review", "ai_failed"]),
    tier: z.enum(["hot", "warm", "cool"]).nullable(),
  }),
  /** A re-score was asked for: every scored lead (personIds null), or the named persons'. */
  "qualification.rescore_requested": z.strictObject({
    workspaceId: z.string(),
    requestId: z.string(),
    personIds: z.array(z.string()).min(1).max(500).nullable(),
  }),
});

/**
 * The start of the workspace's batch: one run at a time by its fixed id, so a start while one runs
 * starts none, and the leads it would have read wait for the next tick.
 */
export function batchStart(workspaceId: string) {
  return {
    workflow: "qualification_batch",
    input: { workspaceId },
    workflowId: `qualification.batch:${workspaceId}:current`,
    oneAtATime: true,
  };
}

// The workspace is the delivery's tenant run, never the payload's.
const startBatch = async () => {
  await startWorkflow(batchStart(currentTenant().workspaceId));
};
subscribe(discovery["discovery.people_imported"], startBatch);
subscribe(icp["icp.updated"], startBatch);

/** The start of one request's re-score, named by the request: a redelivery starts none. */
export function rescoreStart(workspaceId: string, requestId: string, personIds: string[] | null) {
  return {
    workflow: "qualification_rescore",
    input: personIds === null ? { workspaceId } : { workspaceId, personIds },
    workflowId: `qualification.rescore:${workspaceId}:${requestId}`,
  };
}
subscribe(events["qualification.rescore_requested"], async ({ requestId, personIds }) => {
  await startWorkflow(rescoreStart(currentTenant().workspaceId, requestId, personIds));
});
