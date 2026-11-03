// The worker's canceller of cancelWorkflow (README "Outbox"; platform README "Workflows"), bound at
// start beside the starter: a subscriber cancels an open workflow by its id, a schedule's run too.
// Temporal answers the cancel of a closed workflow as done, a no-op, so the canceller describes the
// workflow first: closed, or no workflow of that id (WorkflowNotFoundError), it answers
// `{ cancelled: false }`. One that closes between the two answers `{ cancelled: true }`, and the
// cancel does nothing. The cancel names the run it described, so a later run of the id is never it.
import { type Client, WorkflowNotFoundError } from "@temporalio/client";
import type { WorkflowCanceller } from "@whytide/platform";

export function workflowCanceller(temporal: Pick<Client, "workflow">): WorkflowCanceller {
  return {
    async cancel({ workflowId }) {
      const handle = temporal.workflow.getHandle(workflowId);
      try {
        const { closeTime, runId } = await handle.describe();
        if (closeTime) return { cancelled: false };
        await temporal.workflow.getHandle(workflowId, runId).cancel();
        return { cancelled: true };
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) return { cancelled: false };
        throw error;
      }
    },
  };
}
