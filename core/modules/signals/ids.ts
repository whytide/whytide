// The id prefixes of signals' five tables (core/packages/platform/README.md "Ids"), and an event's id,
// which carries its candidate's ULID (beta-p1-090): the candidate's credit has the candidate as its
// subject, and the staging row is gone after the run, so the event names it for a lead's cost.
import { defineIds } from "@whytide/platform";

export const ids = defineIds({
  src: "signal_source",
  run: "signal_run",
  cand: "signal_candidate",
  sev: "signal_event",
  evd: "evidence",
});

/** The event of a candidate's engagement: `sev_` and the candidate's ULID. */
export const eventIdOf = (candidateId: string): string =>
  `${ids.signal_event}${candidateId.slice(ids.signal_candidate.length)}`;

/** The candidate an event came from, `cand_` and its ULID; an event made before beta-p1-090 names none. */
export const candidateIdOf = (eventId: string): string =>
  `${ids.signal_candidate}${eventId.slice(ids.signal_event.length)}`;
