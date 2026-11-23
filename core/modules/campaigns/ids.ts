// The id prefixes of campaigns' tables (core/packages/platform/README.md "Ids").
import { defineIds } from "@whytide/platform";

export const ids = defineIds({
  cmp: "campaign",
  cmv: "campaign_version",
  enl: "enrollment",
  stp: "step",
  sx: "step_execution",
});
