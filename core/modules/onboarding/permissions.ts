// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md
// §3). Roles are kept, not evaluated, in alpha: every member is Owner.
import { definePermissions } from "@whytide/platform";

export const permissions = definePermissions(
  [
    { action: "company_knowledge.read", roles: ["Owner", "Admin", "Member"] },
    { action: "company_knowledge.write", roles: ["Owner", "Admin"] },
  ],
  import.meta.url,
);
