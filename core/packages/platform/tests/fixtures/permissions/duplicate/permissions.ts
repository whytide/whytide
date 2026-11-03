// A third fixture module claiming an action the leads fixture already registered: importing it, as
// the host does at start, fails with both file names (tests/permissions.test.ts).
import { definePermissions } from "../../../../permissions/index.ts";

export const permissions = definePermissions(
  [{ action: "leads.read", roles: ["Owner"] }],
  import.meta.url,
);
