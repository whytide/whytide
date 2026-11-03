// The priced actions of this module; the credits module assembles them at start (docs/rules/coding.md
// §3, §7). Engagers read are priced by 30, rounded up: a run's quantity is its engagers' blocks of 30
// (domain/runs.ts blocksOf), as credits multiply the price by the quantity without rounding.
import { definePrices } from "@whytide/platform";

export const prices = definePrices(
  [{ action: "signals.engager_read", credits: 1, unit: "engagers_30" }],
  import.meta.url,
);
