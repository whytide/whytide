// restrictions and checkpoints (README.md "Commands"; beta's "Done when": 0 restrictions, any
// checkpoint investigated and explained), in the caller's tenant run: linkedin's health events of the
// period into restricted or checkpoint, oldest first. Ids, a state, a trigger and an instant only.
import { type HealthEventRow, healthEventsSince } from "@whytide/linkedin";

/** The period's warnings, oldest first. */
export const warnings = (period: { readonly since: Date }): Promise<HealthEventRow[]> =>
  healthEventsSince({ since: period.since });
