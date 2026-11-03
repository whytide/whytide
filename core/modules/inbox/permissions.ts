// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md §3).
// inbox.read guards the threads and their messages, inbox.label a reply's label (README.md "API").
import { definePermissions } from "@whytide/platform";

export const permissions = definePermissions(
  [
    { action: "inbox.read", roles: ["Owner", "Admin", "Member"] },
    { action: "inbox.label", roles: ["Owner", "Admin", "Member"] },
  ],
  import.meta.url,
);
