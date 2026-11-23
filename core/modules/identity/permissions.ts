// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md §3).
// identity.invite is the Invites screen's routes' (gamma-p6-020): an Owner invites, lists and revokes.
import { definePermissions } from "@whytide/platform";

export const permissions = definePermissions(
  [{ action: "identity.invite", roles: ["Owner"] }],
  import.meta.url,
);
