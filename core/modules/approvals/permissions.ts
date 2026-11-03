// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md §3).
// approvals.read guards the queue's list; approvals.decide an approval and a skip, which the sender
// account's owner alone may make besides (README.md "Routes").
import { definePermissions } from "@whytide/platform";

export const permissions = definePermissions(
  [
    { action: "approvals.read", roles: ["Owner", "Admin", "Member"] },
    { action: "approvals.decide", roles: ["Owner", "Admin", "Member"] },
  ],
  import.meta.url,
);
