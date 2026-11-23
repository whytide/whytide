// The events this module publishes, written to the outbox in the transaction of the change
// (docs/rules/coding.md §2, §3): ids only. alpha-p8-020 pauses a source whose account is
// disconnected; the workspace is the event's own. Its own subscribers start a refresh the screen asked
// for, and one after a connect, which stores the account's member id (platform README "Workflows"),
// and the owner's mail about a paused account. The receiver (domain/receiver/) publishes a person's
// acceptance and message, the message's text in the file `file_key` names, never in the event
// (beta-p5-010's subscriber reads the file and deletes it). The fleet breaker publishes
// linkedin.invites_paused (domain/health/breaker.ts), whose subscriber mails the operator. tenancy's
// tenancy.member_removed pauses the removed member's accounts (domain/removed.ts, gamma-p6-070).
import { currentTenant, defineEvents, startWorkflow, subscribe } from "@whytide/platform";
import { events as tenancyEvents } from "@whytide/tenancy";
import { z } from "zod";
import { pauseRemovedMember } from "./domain/removed.ts";

export const events = defineEvents({
  "linkedin.sender_account_connected": z.strictObject({ sender_account_id: z.string() }),
  "linkedin.sender_account_disconnected": z.strictObject({ sender_account_id: z.string() }),
  /**
   * Another LinkedIn account behind the row (its member id changed at a refresh): its targets are
   * back to the start and its owner accepts the disclosure again.
   */
  "linkedin.account_replaced": z.strictObject({ sender_account_id: z.string() }),
  /** Refresh status, pressed: the worker asks the provider for the account's status now. */
  "linkedin.status_refresh_requested": z.strictObject({ sender_account_id: z.string() }),
  /** The person accepted the account's invitation; `detected_at` is when Whytide learned it. */
  "linkedin.invite_accepted": z.strictObject({
    sender_account_id: z.string(),
    person_id: z.string(),
    detected_at: z.iso.datetime(),
  }),
  /**
   * A message between the account and the person, `in` from the person or `out` from the account;
   * `file_key` is its file under the workspace's raw/ (schemas/receiver.ts), which lives 72 hours.
   */
  "linkedin.message_received": z.strictObject({
    sender_account_id: z.string(),
    person_id: z.string(),
    direction: z.enum(["in", "out"]),
    file_key: z.string(),
  }),
  /**
   * The account's health paused it, all of it or its invites, or the third provider error in an hour
   * paused it until its next working day: the health event that says so (domain/health/).
   */
  "linkedin.account_paused": z.strictObject({
    sender_account_id: z.string(),
    health_event_id: z.string(),
  }),
  /**
   * The fleet breaker paused the invites of every account of the instance: the account whose warning
   * tripped it, and that warning's health event, in the account's workspace.
   */
  "linkedin.invites_paused": z.strictObject({
    sender_account_id: z.string(),
    health_event_id: z.string(),
  }),
});

// One run per press, and per connect, by the event's id: a second delivery of the event starts none.
// The workspace is the delivery's tenant run, never the payload's.
async function refresh(
  { sender_account_id }: { sender_account_id: string },
  { id }: { id: string },
) {
  const { workspaceId } = currentTenant();
  await startWorkflow({
    workflow: "linkedin_refresh_account",
    input: { workspaceId, accountId: sender_account_id },
    workflowId: `linkedin.status_refresh:${workspaceId}:${id}`,
  });
}
subscribe(events["linkedin.status_refresh_requested"], refresh);
subscribe(events["linkedin.sender_account_connected"], refresh);

// The owner's mail, one per health event: the workflow's id stops a second delivery, and the event's
// owner_notified_at a retry once the mail went (domain/health/mail.ts).
subscribe(events["linkedin.account_paused"], async ({ health_event_id }) => {
  const { workspaceId } = currentTenant();
  await startWorkflow({
    workflow: "linkedin_notify",
    input: { workspaceId, healthEventId: health_event_id, recipient: "owner" },
    workflowId: `linkedin.notify:${workspaceId}:${health_event_id}:owner`,
  });
});

// The operator's mail, one per trip: the same workflow, its id by the warning's event and the
// recipient, and the event's operator_notified_at a retry once the mail went.
subscribe(events["linkedin.invites_paused"], async ({ health_event_id }) => {
  const { workspaceId } = currentTenant();
  await startWorkflow({
    workflow: "linkedin_notify",
    input: { workspaceId, healthEventId: health_event_id, recipient: "operator" },
    workflowId: `linkedin.notify:${workspaceId}:${health_event_id}:operator`,
  });
});

// A member's removal pauses their accounts of the workspace, the delivery's run, in its transaction
// (domain/removed.ts); a redelivery finds them paused and writes nothing.
subscribe(tenancyEvents["tenancy.member_removed"], async ({ userId }) => {
  await pauseRemovedMember(userId);
});
