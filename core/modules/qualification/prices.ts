// The priced actions of this module; the credits module writes them to price_list at the api's start
// (docs/rules/coding.md §3, §7; credits README "Declaring a price"). Never imported by the agent's
// task file, which a host loads from the sources: a second copy would price the action twice.
import { definePrices } from "@whytide/platform";

/** One assessment of a lead by the model, reserved before and committed on a stored snapshot. */
export const prices = definePrices(
  [{ action: "qualification.assessment", credits: 0.2, unit: "lead" }],
  import.meta.url,
);
