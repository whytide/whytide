// The events this module publishes, none, and the one it subscribes to: tenancy's
// organization_created, whose organization gets its subscription and its first grant (docs/flows.md).
// The worker runs the handler in a tenant run of the event's workspace, at least once: the function
// it calls grants a period once, so a second delivery changes nothing.
import type { TenantClient } from "@whytide/db";
import { type EventContext, subscribe } from "@whytide/platform";
import { events as tenancy } from "@whytide/tenancy";
import { seedOrganization } from "./domain/seed.ts";

export const events = [] as const;

subscribe(
  tenancy["tenancy.organization_created"],
  async ({ organizationId }, { tx }: EventContext<TenantClient>) => {
    await seedOrganization(tx, organizationId);
  },
);
