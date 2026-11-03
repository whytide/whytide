// The id prefixes of qualification's two tables and of a re-score request (core/packages/platform/
// README.md "Ids").
import { defineIds } from "@whytide/platform";

export const ids = defineIds({
  ssn: "score_snapshot",
  cvd: "criterion_verdict",
  rsq: "rescore_request",
});
