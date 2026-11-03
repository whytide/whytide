// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md §3).
import { definePermissions } from "@whytide/platform";

export const permissions = definePermissions(
  [
    { action: "signals.read", roles: ["Owner", "Admin", "Member"] },
    { action: "signals.write", roles: ["Owner", "Admin"] },
    { action: "signals.run", roles: ["Owner", "Admin"] },
  ],
  import.meta.url,
);
