// The id prefixes of tenancy's four tables (core/packages/platform/README.md "Ids").
import { defineIds } from "@whytide/platform";

export const ids = defineIds({
  usr: "user",
  org: "organization",
  wsp: "workspace",
  mem: "membership",
});
