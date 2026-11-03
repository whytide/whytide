// The events this module publishes, written to the outbox in the same transaction as the change
// (docs/rules/coding.md §2, §3; core/packages/platform/README.md "Events and the outbox").
import { defineEvents } from "@whytide/platform";
import { z } from "zod";
import { REVIEW_DECISIONS } from "./domain/review/rules.ts";

export const events = defineEvents({
  /** reviewLead appended a decision: ids and the decision, never a reason's text. */
  "contacts.lead_reviewed": z.strictObject({
    workspaceId: z.string(),
    personId: z.string(),
    decision: z.enum(REVIEW_DECISIONS),
  }),
});
