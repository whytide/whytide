// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md §3).
// identity.invite is the invite screen's, later: in alpha an engineer invites with `pnpm invite`.
import { definePermissions } from "@whytide/platform";

export const permissions = definePermissions(
  [{ action: "identity.invite", roles: ["Owner"] }],
  import.meta.url,
);
