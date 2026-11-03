// The id prefixes of icp's two tables and of a draft's run, which the ICP and the workflow's input
// carry (core/packages/platform/README.md "Ids").
import { defineIds } from "@whytide/platform";

export const ids = defineIds({ icp: "icp", crit: "criterion", idrun: "icp_draft_run" });
