// The events this module publishes, written to the outbox in the same transaction as the change
// (docs/rules/coding.md §2, §3; core/packages/platform/README.md "Events and the outbox"). Ids and
// codes only. campaigns makes an agent's campaign on playbooks.playbook_created (gamma-p3-065), with
// the owner it carries: playbooks never imports campaigns. tenancy's tenancy.member_removed pauses
// the removed member's agents (domain/removed.ts, gamma-p6-075): playbooks imports tenancy's events,
// never the other way round.
import { defineEvents, subscribe } from "@whytide/platform";
import { events as tenancyEvents } from "@whytide/tenancy";
import { z } from "zod";
import { PLAYBOOK_STATUSES } from "./domain/constants.ts";
import { pauseRemovedMember } from "./domain/removed.ts";

export const events = defineEvents({
  /** A member created agent `playbookId` on audience `icpId`, owned by them; once per agent. */
  "playbooks.playbook_created": z.strictObject({
    playbookId: z.string(),
    ownerUserId: z.string(),
    icpId: z.string(),
  }),
  /** Agent `playbookId` changed: its name, its audience or its status, `status` its new one. */
  "playbooks.playbook_updated": z.strictObject({
    playbookId: z.string(),
    status: z.enum(PLAYBOOK_STATUSES),
  }),
  /** Agent `playbookId`'s set of sources was replaced (setSources). */
  "playbooks.sources_changed": z.strictObject({ playbookId: z.string() }),
});

// A member's removal pauses their agents of the workspace, the delivery's run, in its transaction
// (domain/removed.ts); a redelivery finds them paused for it and writes nothing.
subscribe(tenancyEvents["tenancy.member_removed"], async ({ userId }) => {
  await pauseRemovedMember(userId);
});
