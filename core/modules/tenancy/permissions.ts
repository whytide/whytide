// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md §3).
// workspace.read guards the member list, for every role; members.manage a role change and a removal,
// for an Owner (gamma-p6-030; docs/security.md "Who may do what").
import { definePermissions } from "@whytide/platform";
import { MEMBERS_MANAGE_ROLES } from "./domain/constants.ts";

export const permissions = definePermissions(
  [
    { action: "members.manage", roles: [...MEMBERS_MANAGE_ROLES] },
    { action: "workspace.read", roles: ["Owner", "Admin", "Member"] },
  ],
  import.meta.url,
);
