// The id prefixes of contacts' tables (core/packages/platform/README.md "Ids"); a lead's key is its
// person's.
import { defineIds } from "@whytide/platform";

export const ids = defineIds({
  per: "person",
  wco: "workspace_company",
  phash: "person_hash",
  rvd: "review_decision",
  sup: "suppression_entry",
  lsc: "lead_status_change",
});
