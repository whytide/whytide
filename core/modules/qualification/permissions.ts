// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md
// §3) and its `can` evaluates their roles: a Member is refused qualification.rescore.
import { definePermissions } from "@whytide/platform";

export const permissions = definePermissions(
  [{ action: "qualification.rescore", roles: ["Owner", "Admin"] }],
  import.meta.url,
);
