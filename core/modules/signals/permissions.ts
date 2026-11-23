// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md §3).
// Every member reads the sources, adds their own and edits, runs, stops and deletes them
// (signals.write, signals.run); signals.manage writes every one, which the commands check on the row
// (README "Decided here").
import { definePermissions } from "@whytide/platform";
import { SIGNALS_MANAGE_ROLES } from "./domain/constants.ts";

export const permissions = definePermissions(
  [
    { action: "signals.manage", roles: [...SIGNALS_MANAGE_ROLES] },
    { action: "signals.read", roles: ["Owner", "Admin", "Member"] },
    { action: "signals.write", roles: ["Owner", "Admin", "Member"] },
    { action: "signals.run", roles: ["Owner", "Admin", "Member"] },
  ],
  import.meta.url,
);
