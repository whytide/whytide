// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md
// §3). Every member reads their own accounts and connects, changes, pauses and disconnects them; an
// Owner's or Admin's linkedin.manage sees and pauses every member's and stops the workspace
// (domain/access.ts, gamma-p6-070).
import { definePermissions } from "@whytide/platform";
import { LINKEDIN_MANAGE_ROLES } from "./domain/controls/constants.ts";

export const permissions = definePermissions(
  [
    { action: "linkedin.read", roles: ["Owner", "Admin", "Member"] },
    { action: "linkedin.connect", roles: ["Owner", "Admin", "Member"] },
    { action: "linkedin.manage", roles: [...LINKEDIN_MANAGE_ROLES] },
  ],
  import.meta.url,
);
