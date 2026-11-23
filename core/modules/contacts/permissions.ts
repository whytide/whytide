// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md §3).
// contacts.read guards the person routes, leads.read the lead routes, leads.approve Approve,
// reviews.write a review decision and reviews.read the history and the weekly summary, exports.read
// the leads CSV and qualification's golden set; contacts.write a member's edit of a lead's profile
// fields (lead-fields-edit).
// The never-contact list (gamma-p2-040): suppression.read guards the list; suppression.write every
// addition, an entry, a customer or competitor, an opt-out by hand, and gamma-p2-045's lists, for
// every role, since an addition only stops sends; suppression.remove what lifts an exclusion, the
// DELETE of an entry and gamma-p2-045's list removal, for Owner with Admin beside it, since a lift
// lets sends start again (docs/security.md "Who may do what").
import { definePermissions } from "@whytide/platform";
import { SUPPRESSION_REMOVE_ROLES } from "./domain/suppression/constants.ts";

export const permissions = definePermissions(
  [
    { action: "contacts.read", roles: ["Owner", "Admin", "Member"] },
    { action: "contacts.write", roles: ["Owner", "Admin", "Member"] },
    { action: "exports.read", roles: ["Owner", "Admin"] },
    { action: "leads.approve", roles: ["Owner", "Admin", "Member"] },
    { action: "leads.read", roles: ["Owner", "Admin", "Member"] },
    { action: "reviews.read", roles: ["Owner", "Admin", "Member"] },
    { action: "reviews.write", roles: ["Owner", "Admin", "Member"] },
    { action: "suppression.read", roles: ["Owner", "Admin", "Member"] },
    { action: "suppression.remove", roles: [...SUPPRESSION_REMOVE_ROLES] },
    { action: "suppression.write", roles: ["Owner", "Admin", "Member"] },
  ],
  import.meta.url,
);
