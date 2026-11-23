// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md
// §3). Every member reads the agents and creates and writes their own (playbooks.write);
// playbooks.manage writes every one, which the commands check on the row (README "Decided here").
import { definePermissions } from "@whytide/platform";
import { PLAYBOOKS_MANAGE_ROLES } from "./domain/constants.ts";

export const permissions = definePermissions(
  [
    { action: "playbooks.manage", roles: [...PLAYBOOKS_MANAGE_ROLES] },
    { action: "playbooks.read", roles: ["Owner", "Admin", "Member"] },
    { action: "playbooks.write", roles: ["Owner", "Admin", "Member"] },
  ],
  import.meta.url,
);
