// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md
// §3). Every member reads the accounts and connects their own; changing or disconnecting an account is
// an Owner's or Admin's. Roles are kept, not evaluated, in alpha: every member is Owner.
import { definePermissions } from "@whytide/platform";

export const permissions = definePermissions(
  [
    { action: "linkedin.read", roles: ["Owner", "Admin", "Member"] },
    { action: "linkedin.connect", roles: ["Owner", "Admin", "Member"] },
    { action: "linkedin.manage", roles: ["Owner", "Admin"] },
  ],
  import.meta.url,
);
