// The event this module publishes, campaigns.step_sent once a send went out and was settled (ids and
// the action only; docs/flows.md "The sender"), and the five it subscribes to: contacts' lead_approved,
// whose lead is enrolled in the template (docs/flows.md "Approve → enrollment"); contacts'
// suppression_added, which exits every active enrollment of a person now suppressed (docs/flows.md
// "The suppression subscriber"); approvals' item_decided, the owner's decision in "Up next",
// which schedules or skips the step (docs/flows.md "The decision"); linkedin's invite_accepted,
// which records the acceptance and makes the first message due (docs/flows.md "Acceptance → the
// first message"); and linkedin's account_replaced, which ends the account's active enrollments
// (docs/flows.md "A replaced account"). The worker runs each handler in a delivery transaction of
// its own for the event's workspace, at least once: the event's id, the one active enrollment per
// person and the moves conditioned on a step's status, item and acceptance make a second delivery
// change nothing, and an exited enrollment is not checked again.
import { events as approvals } from "@whytide/approvals";
import { events as contacts } from "@whytide/contacts";
import type { TenantClient } from "@whytide/db";
import { events as linkedin } from "@whytide/linkedin";
import { defineEvents, type EventContext, subscribe } from "@whytide/platform";
import { z } from "zod";
import { recordAcceptance } from "./domain/acceptance.ts";
import { now } from "./domain/clock.ts";
import { ACTION_TYPES, ID_MAX } from "./domain/constants.ts";
import { applyDecision } from "./domain/decisions.ts";
import { enrollApproved } from "./domain/enroll/enroll.ts";
import { exitSuppressedEnrollments } from "./domain/gate/suppressed.ts";
import { endReplacedEnrollments } from "./domain/replaced.ts";

const id = z.string().min(1).max(ID_MAX);

export const events = defineEvents({
  /** A step's send went out and is settled: `succeeded`, its touch recorded. Never a text. */
  "campaigns.step_sent": z.strictObject({
    stepExecutionId: id,
    personId: id,
    actionType: z.enum(ACTION_TYPES),
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
