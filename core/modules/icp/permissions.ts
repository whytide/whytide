// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md
// §3). Every member reads the audiences and writes their own (icp.write); icp.manage writes every
// one, the default and another member's, which the commands check on the row (README "Decided here").
import { definePermissions } from "@whytide/platform";
import { ICP_MANAGE_ROLES } from "./domain/constants.ts";

export const permissions = definePermissions(
  [
    { action: "icp.manage", roles: [...ICP_MANAGE_ROLES] },
    { action: "icp.read", roles: ["Owner", "Admin", "Member"] },
    { action: "icp.write", roles: ["Owner", "Admin", "Member"] },
  ],
  import.meta.url,
);
