// The events this module publishes; written to the outbox in the same transaction as the change (docs/rules/coding.md §2, §3).
import { defineEvents } from "@whytide/platform";
import { z } from "zod";

export const events = defineEvents({
  /** bootstrapOrganization made an organization and its first workspace; ids only (credits subscribes). */
  "tenancy.organization_created": z.object({ organizationId: z.string(), workspaceId: z.string() }),
});
