// The id prefixes of signals' five tables (core/packages/platform/README.md "Ids").
import { defineIds } from "@whytide/platform";

export const ids = defineIds({
  src: "signal_source",
  run: "signal_run",
  cand: "signal_candidate",
  sev: "signal_event",
  evd: "evidence",
});
