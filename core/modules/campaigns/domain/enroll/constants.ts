// The enrollment's values (README.md "Enrolling"; gamma-p3-065): the kind of lead source routing
// reads, whose `ref` is a signal source's id, the one an agent may hold.
import type { LeadSource } from "@whytide/contacts";

/** contacts' source kind of a lead found by a signal source. */
export const SIGNAL_SOURCE_KIND = "signal" satisfies LeadSource["kind"];
