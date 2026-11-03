// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md §3).
// campaigns.read guards the enrollments route and the counts route (README.md "Routes").
import { definePermissions } from "@whytide/platform";

export const permissions = definePermissions(
  [{ action: "campaigns.read", roles: ["Owner", "Admin", "Member"] }],
  import.meta.url,
);
