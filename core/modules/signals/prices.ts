// The priced actions of this module; the credits module assembles them at start (docs/rules/coding.md
// §3, §7). An engager whose profile a run reads costs SIGNALS_CREDITS_PER_ENGAGER, its setting when
// the module loads, which credits' PRICE_SIGNALS_ENGAGER overrides (beta-p1-090). Engagers read by a
// run started before that are priced by 30, rounded up: such a run's quantity is its engagers'
// blocks of 30 (domain/runs.ts blocksOf), as credits multiply the price by the quantity without
// rounding; the action stays for those runs and for the leads' costs, and no new run reserves it.
import { definePrices } from "@whytide/platform";
import { settings } from "./settings.ts";

export const prices = definePrices(
  [
    { action: "signals.engager", credits: settings.SIGNALS_CREDITS_PER_ENGAGER, unit: "engager" },
    { action: "signals.engager_read", credits: 1, unit: "engagers_30" },
  ],
  import.meta.url,
);
