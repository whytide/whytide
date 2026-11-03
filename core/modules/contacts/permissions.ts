// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md §3).
// contacts.read guards the person routes, leads.read the lead routes, reviews.write a review
// decision and reviews.read the history and the weekly summary, exports.read the leads CSV and
// qualification's golden set; contacts.write is for the writes of later tasks.
import { definePermissions } from "@whytide/platform";

export const permissions = definePermissions(
  [
    { action: "contacts.read", roles: ["Owner", "Admin", "Member"] },
    { action: "contacts.write", roles: ["Owner", "Admin", "Member"] },
    { action: "exports.read", roles: ["Owner", "Admin", "Member"] },
    { action: "leads.read", roles: ["Owner", "Admin", "Member"] },
    { action: "reviews.read", roles: ["Owner", "Admin", "Member"] },
    { action: "reviews.write", roles: ["Owner", "Admin", "Member"] },
  ],
  import.meta.url,
);
