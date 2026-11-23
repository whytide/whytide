// The events this module publishes, written to the outbox in the same transaction as the change
// (docs/rules/coding.md §2, §3; core/packages/platform/README.md "Events and the outbox").
import { defineEvents } from "@whytide/platform";
import { z } from "zod";
import { REVIEW_DECISIONS } from "./domain/review/rules.ts";
import {
  EVERY_CHANNEL,
  SUPPRESSION_CHANNELS,
  SUPPRESSION_LAYERS,
} from "./domain/suppression/constants.ts";

export const events = defineEvents({
  /** reviewLead appended a decision: ids and the decision, never a reason's text. */
  "contacts.lead_reviewed": z.strictObject({
    workspaceId: z.string(),
    personId: z.string(),
    decision: z.enum(REVIEW_DECISIONS),
  }),
  /**
   * addSuppression or addOptOut wrote a new entry: its id, its layer and its channel, never its
   * value. A row written before channels (gamma-p2-040) has none and is read as `all`. An exclusion
   * list's import (gamma-p2-045) publishes one for the whole list, with its first entry's id and
   * `listId`, and none when it added no entry.
   */
  "contacts.suppression_added": z.strictObject({
    suppressionId: z.string(),
    layer: z.enum(SUPPRESSION_LAYERS),
    channel: z.enum(SUPPRESSION_CHANNELS).default(EVERY_CHANNEL),
    listId: z.string().optional(),
  }),
  /** approveLead approved the lead, again too: the person and the user; campaigns enrolls it. */
  "contacts.lead_approved": z.strictObject({
    personId: z.string(),
    approvedBy: z.string(),
  }),
});
