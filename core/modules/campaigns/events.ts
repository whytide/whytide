// The event this module publishes, campaigns.step_sent once a send went out and was settled (ids and
// the action only; docs/flows.md "The sender"), and the five it subscribes to: contacts' lead_approved,
// whose lead is enrolled in the template (docs/flows.md "Approve → enrollment"); contacts'
// suppression_added, which exits every active enrollment of a person now suppressed (docs/flows.md
// "The suppression subscriber"); approvals' item_decided, the owner's decision in "Up next",
// which schedules or skips the step (docs/flows.md "The decision"); linkedin's invite_accepted,
// which records the acceptance and makes the first message due (docs/flows.md "Acceptance → the
// first message"); and linkedin's account_replaced, which ends the account's active enrollments
// (docs/flows.md "A replaced account"). gamma-p4-050: campaigns.reply_notice_due, a reply label's
// notice to the owner (interested, or not_now's reminder; ids only), and its own subscriber, which
// starts the notice's workflow, one per event (docs/flows.md "A reply's label"). gamma-p3-065:
// playbooks' playbook_created, which makes the agent's one campaign, a draft (docs/flows.md "An
// agent's campaign"); campaigns imports playbooks, never the reverse. gamma-p6-040: tenancy's
// member_removed, which ends the enrollments of the member's campaigns and accounts (docs/flows.md
// "A removed member"). The worker runs each handler in a delivery transaction of its own for the
// event's workspace, at least once: the event's id, the one active enrollment per person, the one
// campaign per agent and the moves conditioned on a step's status, item and acceptance make a
// second delivery change nothing, and an exited enrollment is not checked again.
import { events as approvals } from "@whytide/approvals";
import { events as contacts } from "@whytide/contacts";
import type { TenantClient } from "@whytide/db";
import { events as linkedin } from "@whytide/linkedin";
import {
  currentTenant,
  defineEvents,
  type EventContext,
  startWorkflow,
  subscribe,
} from "@whytide/platform";
import { events as playbooks } from "@whytide/playbooks";
import { events as tenancy } from "@whytide/tenancy";
import { z } from "zod";
import { recordAcceptance } from "./domain/acceptance.ts";
import { makeAgentCampaign } from "./domain/campaigns/agent.ts";
import { now } from "./domain/clock.ts";
import { ID_MAX, LINKEDIN_ACTIONS } from "./domain/constants.ts";
import { applyDecision } from "./domain/decisions.ts";
import { enrollApproved } from "./domain/enroll/enroll.ts";
import { exitSuppressedEnrollments } from "./domain/gate/suppressed.ts";
import { endRemovedEnrollments } from "./domain/removed.ts";
import { endReplacedEnrollments } from "./domain/replaced.ts";
import { NOTICE_WORKFLOW, REPLY_NOTICE_KINDS } from "./domain/replies/constants.ts";

const id = z.string().min(1).max(ID_MAX);

export const events = defineEvents({
  /** A step's send went out and is settled: `succeeded`, its touch recorded. Never a text. */
  "campaigns.step_sent": z.strictObject({
    stepExecutionId: id,
    personId: id,
    actionType: z.enum(LINKEDIN_ACTIONS),
  }),
  /**
   * A reply label's notice is due (domain/replies/): `interested` links the reply's thread, `not_now`
   * (its reminder, with no thread) the lead; the owner is the user the mail goes to. Ids only.
   */
  "campaigns.reply_notice_due": z.strictObject({
    enrollmentId: id,
    personId: id,
    kind: z.enum(REPLY_NOTICE_KINDS),
    threadId: id.nullable(),
    ownerUserId: id,
  }),
});

subscribe(
  contacts["contacts.lead_approved"],
  async ({ personId, approvedBy }, { id, tx }: EventContext<TenantClient>) => {
    await enrollApproved(tx, { sourceEventId: id, personId, approvedBy });
  },
);

subscribe(
  contacts["contacts.suppression_added"],
  async (_entry, { tx }: EventContext<TenantClient>) => {
    await exitSuppressedEnrollments(tx, new Date());
  },
);

// The ids only: the decision is the item's stored status, read again (domain/decisions.ts).
subscribe(
  approvals["approvals.item_decided"],
  async ({ approvalItemId, stepExecutionId }, { tx }: EventContext<TenantClient>) => {
    await applyDecision(tx, { approvalItemId, stepExecutionId });
  },
);

// The detection, when Whytide learned of the acceptance, anchors the first message; LinkedIn's own
// time of it is linkedin's (domain/acceptance.ts).
subscribe(
  linkedin["linkedin.invite_accepted"],
  async (accepted, { tx }: EventContext<TenantClient>) => {
    const { sender_account_id, person_id, detected_at } = accepted;
    const detectedAt = new Date(detected_at);
    await recordAcceptance(tx, {
      senderAccountId: sender_account_id,
      personId: person_id,
      detectedAt,
    });
  },
);

// Another LinkedIn account behind the sender account (beta-p4-040): its active enrollments end.
subscribe(
  linkedin["linkedin.account_replaced"],
  async ({ sender_account_id }, { tx }: EventContext<TenantClient>) => {
    await endReplacedEnrollments(tx, sender_account_id, now());
  },
);

// A removed member (domain/removed.ts): the enrollments of the campaigns they own, and those sending
// from their account, end in the delivery's run; the gate checks the owner again before each send.
subscribe(
  tenancy["tenancy.member_removed"],
  async ({ userId }, { tx }: EventContext<TenantClient>) => {
    await endRemovedEnrollments(tx, userId, now());
  },
);

// An agent's campaign (domain/campaigns/agent.ts), in the delivery's run, owned by the owner the
// event carries: a second delivery makes none.
subscribe(playbooks["playbooks.playbook_created"], async ({ playbookId, ownerUserId }) => {
  await makeAgentCampaign({ playbookId, ownerUserId });
});

// A reply label's notice (domain/replies/notice.ts): its own workflow per event, so a redelivery
// starts none; the mail goes from its activity, outside this delivery.
subscribe(
  events["campaigns.reply_notice_due"],
  async (notice, { id: eventId }: EventContext<TenantClient>) => {
    const { workspaceId } = currentTenant();
    await startWorkflow({
      workflow: "campaigns_reply_notice",
      input: { workspaceId, ...notice },
      workflowId: `${NOTICE_WORKFLOW}:${workspaceId}:${eventId}`,
    });
  },
);
