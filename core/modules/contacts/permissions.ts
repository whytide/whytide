// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md §3).
// contacts.read guards the person routes, leads.read the lead routes, leads.approve Approve,
// reviews.write a review decision and reviews.read the history and the weekly summary, exports.read
// the leads CSV and qualification's golden set, suppression.read the never-contact list and
// suppression.write its additions and removals; contacts.write is for the writes of later tasks.
import { definePermissions } from "@whytide/platform";

export const permissions = definePermissions(
  [
    { action: "contacts.read", roles: ["Owner", "Admin", "Member"] },
    { action: "contacts.write", roles: ["Owner", "Admin", "Member"] },
    { action: "exports.read", roles: ["Owner", "Admin", "Member"] },
    { action: "leads.approve", roles: ["Owner", "Admin", "Member"] },
    { action: "leads.read", roles: ["Owner", "Admin", "Member"] },
    { action: "reviews.read", roles: ["Owner", "Admin", "Member"] },
    { action: "reviews.write", roles: ["Owner", "Admin", "Member"] },
    { action: "suppression.read", roles: ["Owner", "Admin", "Member"] },
    { action: "suppression.write", roles: ["Owner", "Admin", "Member"] },
  ],
  import.meta.url,
);
