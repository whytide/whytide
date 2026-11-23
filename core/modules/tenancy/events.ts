// The events this module publishes; written to the outbox in the same transaction as the change (docs/rules/coding.md §2, §3).
import { defineEvents } from "@whytide/platform";
import { z } from "zod";

export const events = defineEvents({
  /** bootstrapOrganization made an organization and its first workspace; ids only (credits subscribes). */
  "tenancy.organization_created": z.object({ organizationId: z.string(), workspaceId: z.string() }),
  /**
   * removeMember removed a member, once; ids only. linkedin pauses the member's account, campaigns
   * ends the enrollments that send from it, email disconnects the member's mailbox and playbooks
   * pauses their agents (gamma-p6-070, gamma-p6-040, gamma-p6-075).
   */
  "tenancy.member_removed": z.object({
    workspaceId: z.string(),
    membershipId: z.string(),
    userId: z.string(),
  }),
});
