// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md
// §3). A mailbox is a member's own: every member reads and connects their own, and the module checks
// the row's owner; email.manage, an Owner's or Admin's, also shows the teammates' mailboxes. Roles are
// kept, not evaluated, until gamma-p6-010: every member holds all three.
import { definePermissions } from "@whytide/platform";

export const permissions = definePermissions(
  [
    { action: "email.read", roles: ["Owner", "Admin", "Member"] },
    { action: "email.connect", roles: ["Owner", "Admin", "Member"] },
    { action: "email.manage", roles: ["Owner", "Admin"] },
  ],
  import.meta.url,
);
