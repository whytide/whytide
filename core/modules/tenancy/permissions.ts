// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md §3).
import { definePermissions } from "@whytide/platform";

export const permissions = definePermissions(
  [{ action: "workspace.read", roles: ["Owner", "Admin", "Member"] }],
  import.meta.url,
);
