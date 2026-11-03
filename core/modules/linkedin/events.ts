// The events this module publishes, written to the outbox in the transaction of the change
// (docs/rules/coding.md §2, §3): ids only. alpha-p8-020 pauses a source whose account is
// disconnected; the workspace is the event's own. Its own subscriber starts a refresh the screen asked
// for (platform README "Workflows").
import { currentTenant, defineEvents, startWorkflow, subscribe } from "@whytide/platform";
import { z } from "zod";

export const events = defineEvents({
  "linkedin.sender_account_connected": z.strictObject({ sender_account_id: z.string() }),
  "linkedin.sender_account_disconnected": z.strictObject({ sender_account_id: z.string() }),
  /** Refresh status, pressed: the worker asks the provider for the account's status now. */
  "linkedin.status_refresh_requested": z.strictObject({ sender_account_id: z.string() }),
});

// One run per press, by the event's id: a second delivery of the event starts none. The workspace is
// the delivery's tenant run, never the payload's.
subscribe(events["linkedin.status_refresh_requested"], async ({ sender_account_id }, { id }) => {
  const { workspaceId } = currentTenant();
  await startWorkflow({
    workflow: "linkedin_refresh_account",
    input: { workspaceId, accountId: sender_account_id },
    workflowId: `linkedin.status_refresh:${workspaceId}:${id}`,
  });
});
