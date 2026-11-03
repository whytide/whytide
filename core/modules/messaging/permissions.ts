// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md §3).
// drafts.read guards the dossier and the draft reads; drafts.write a draft's request, edit and
// regeneration (README.md "Routes").
import { definePermissions } from "@whytide/platform";

export const permissions = definePermissions(
  [
    { action: "drafts.read", roles: ["Owner", "Admin", "Member"] },
    { action: "drafts.write", roles: ["Owner", "Admin", "Member"] },
  ],
  import.meta.url,
);
