// The events this module publishes, written to the outbox in the same transaction as the change
// (docs/rules/coding.md §2, §3; core/packages/platform/README.md "Events and the outbox"), and its
// own subscriber, which starts a draft's workflow in the worker (platform README "Workflows").
import { currentTenant, defineEvents, startWorkflow, subscribe } from "@whytide/platform";
import { z } from "zod";

const id = z.string().min(1).max(64);
/**
 * A member asked for draft `draftId` of the person, a regeneration of `replacesId` when given: the
 * worker writes it for `userId`, the member, who is its sender.
 */
const draftRequested = z.strictObject({
  workspaceId: id,
  draftId: id,
  personId: id,
  userId: id,
  replacesId: id.optional(),
});
export type DraftRequest = z.output<typeof draftRequested>;

export const events = defineEvents({ "messaging.draft_requested": draftRequested });

/**
 * The start of a draft's workflow (README.md "The workflow"), by the draft's id: a second delivery
 * of the event starts no second run, as the starter answers `{ started: false }` for it.
 */
export function draftStart(request: DraftRequest) {
  const { workspaceId, draftId } = request;
  return {
    workflow: "messaging_draft_message",
    input: request,
    workflowId: `messaging.draft:${workspaceId}:${draftId}`,
  };
}

// The workspace is the delivery's tenant run, never the payload's: the starter compares none.
subscribe(events["messaging.draft_requested"], async (payload) => {
  await startWorkflow(draftStart({ ...payload, workspaceId: currentTenant().workspaceId }));
});
