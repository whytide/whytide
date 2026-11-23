// A fixture module's permissions.ts with each shape an action's roles take (tests/permissions.test.ts):
// Owner only, Owner and Admin, every role, and none, which only a service may do.
import { definePermissions } from "../../../../permissions/index.ts";

export const permissions = definePermissions(
  [
    { action: "shapes.owner", roles: ["Owner"] },
    { action: "shapes.owner_admin", roles: ["Owner", "Admin"] },
    { action: "shapes.every_role", roles: ["Owner", "Admin", "Member"] },
    { action: "shapes.service_only", roles: [] },
  ],
  import.meta.url,
);
