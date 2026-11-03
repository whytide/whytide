// The events this module publishes, written to the outbox in the same transaction as the change
// (docs/rules/coding.md §2, §3; core/packages/platform/README.md "Events and the outbox"), and its
// subscriber to messaging's step_draft_ready, which attaches an ended draft to its step's pending
// item in the delivery's transaction. campaigns subscribes to approvals.item_decided (beta-p3-050).
import type { TenantClient } from "@whytide/db";
import { events as messaging } from "@whytide/messaging";
import { defineEvents, type EventContext, subscribe } from "@whytide/platform";
import { z } from "zod";
import { DECISIONS, ID_MAX } from "./domain/items/constants.ts";
import { attachDraft } from "./domain/items/open.ts";

const id = z.string().min(1).max(ID_MAX);

export const events = defineEvents({
  /** The owner approved or skipped the item: ids and the decision only, never a text. */
  "approvals.item_decided": z.strictObject({
    approvalItemId: id,
    stepExecutionId: id,
    decision: z.enum(DECISIONS),
  }),
});

// At least once: the attach changes a pending item without a draft only, so a redelivery is a no-op.
subscribe(
  messaging["messaging.step_draft_ready"],
  async ({ draftId, stepExecutionId }, { tx }: EventContext<TenantClient>) => {
    await attachDraft(tx, { draftId, stepExecutionId });
  },
);
