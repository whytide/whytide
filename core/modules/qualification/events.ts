// The events this module publishes, written to the outbox in the same transaction as the change
// (docs/rules/coding.md §2, §3; core/packages/platform/README.md "Events and the outbox"), and the
// subscriptions: three start the workspace's batch at once (README "The batch"): an import, a
// change of the default audience and of any audience (gamma-p5-050), and so does its own
// reassess_requested (README "A new assessment"), its own re-score request starts the re-score
// (README "The re-score"), and its own lead_hot claims the lead's Hot alert and starts its mail
// (README "The Hot alert").
import { events as discovery } from "@whytide/discovery";
import { events as icp } from "@whytide/icp";
import { currentTenant, defineEvents, startWorkflow, subscribe } from "@whytide/platform";
import { z } from "zod";
import { claimHotAlert } from "./domain/alert/claim.ts";
import { HOT_ALERT_WORKFLOW } from "./domain/alert/constants.ts";

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
  /** A member asked the AI to assess a decided lead again: ids only. */
  "qualification.reassess_requested": z.strictObject({
    workspaceId: z.string(),
    personId: z.string(),
  }),
  /** An intent write took the lead into Hot: ids only. */
  "qualification.lead_hot": z.strictObject({ workspaceId: z.string(), personId: z.string() }),
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
// Every audience's change, the default's too, which publishes both: the batch's one run at a time
// makes that one batch, which assesses the leads decided against the audience at its older version.
subscribe(icp["icp.audience_updated"], startBatch);
subscribe(events["qualification.reassess_requested"], startBatch);

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

/** The start of one entry's Hot alert, named by its event: one run per event. */
export function hotAlertStart(workspaceId: string, personId: string, eventId: string) {
  return {
    workflow: "qualification_hot_alert",
    input: { workspaceId, personId },
    workflowId: `${HOT_ALERT_WORKFLOW}:${workspaceId}:${eventId}`,
  };
}
// The claim in the delivery's run, then the start: a retried delivery finds the claim and starts
// none, a start that fails rolls the claim back, and the mail goes from the workflow, never from
// this run (domain/alert/mail.ts).
subscribe(events["qualification.lead_hot"], async ({ personId }, { id: eventId }) => {
  if (!(await claimHotAlert(personId, new Date()))) return;
  await startWorkflow(hotAlertStart(currentTenant().workspaceId, personId, eventId));
});
