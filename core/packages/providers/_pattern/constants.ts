// The pattern's fixed values (README.md "Many adapters per port"): how a PROVIDER_<PORT> list and an
// <ADAPTER>_ALLOWANCE are written, and the names an adapter's declarations take on a bound adapter,
// which no port method may take.

/** What separates the adapter names of a PROVIDER_<PORT> list: `wikidata,companies-house`. */
export const PROVIDER_LIST_SEPARATOR = ",";

/** The periods a vendor's free allowance renews over: calendar days and months, in UTC. */
export const ALLOWANCE_PERIODS = ["day", "month"] as const;
/** The fewest and the most calls an allowance may allow per period. */
export const ALLOWANCE_MIN_CALLS = 1;
export const ALLOWANCE_MAX_CALLS = 10_000_000;
/** `<count>/<period>`: the count in digits without a leading zero. */
export const ALLOWANCE = new RegExp(`^([1-9][0-9]*)/(${ALLOWANCE_PERIODS.join("|")})$`);

/** What a bound adapter exposes beside the port's methods, from its definition. */
export const ADAPTER_DECLARATIONS: readonly string[] = ["allowance", "openData"];
