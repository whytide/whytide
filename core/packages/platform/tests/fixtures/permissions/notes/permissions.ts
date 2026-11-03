// A second fixture module's permissions.ts (tests/permissions.test.ts): its actions join the same table.
import { definePermissions } from "../../../../permissions/index.ts";

export const permissions = definePermissions(
  [{ action: "notes.read", roles: ["Owner", "Admin", "Member"] }],
  import.meta.url,
);
