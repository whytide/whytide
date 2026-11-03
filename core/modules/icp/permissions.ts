// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md
// §3). Roles are kept, not evaluated, in alpha: every member is Owner.
import { definePermissions } from "@whytide/platform";

export const permissions = definePermissions(
  [
    { action: "icp.read", roles: ["Owner", "Admin", "Member"] },
    { action: "icp.write", roles: ["Owner", "Admin"] },
  ],
  import.meta.url,
);
