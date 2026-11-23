// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md
// §3). enrichment.read guards a lead's runs, enrichment.run a request for one (gamma-en-055's button),
// for every role, as contacts' contacts.read and contacts.write.
import { definePermissions } from "@whytide/platform";
import { READ_ROLES, RUN_ROLES } from "./domain/lead/constants.ts";

export const permissions = definePermissions(
  [
    { action: "enrichment.read", roles: [...READ_ROLES] },
    { action: "enrichment.run", roles: [...RUN_ROLES] },
  ],
  import.meta.url,
);
