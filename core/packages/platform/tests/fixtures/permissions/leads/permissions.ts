// A fixture module's permissions.ts (tests/permissions.test.ts): the shape every module declares,
// registered when the host imports the module at start.
import { definePermissions } from "../../../../permissions/index.ts";

export const permissions = definePermissions(
  [
    { action: "leads.read", roles: ["Owner", "Admin", "Member"] },
    { action: "leads.write", roles: ["Owner", "Admin"] },
  ],
  import.meta.url,
);
