// The fixed values of `pnpm icp:draft` (README.md "The script").

export const DRAFT_USAGE =
  "usage: pnpm icp:draft --workspace <id or slug> [--brief <text> | --brief-file <path>] [--dry-run] [--replace]";

/** The exit codes: shown or saved, refused, a usage error, the draft failed, superseded, timed out. */
export const EXIT = {
  done: 0,
  refused: 1,
  usage: 2,
  failed: 3,
  superseded: 4,
  timedOut: 5,
} as const;

/**
 * How often the script reads the ICP while the worker drafts, and for how long at most: longer than
 * the drafter's three attempts of up to three minutes each (workflows/constants.ts).
 */
export const POLL_MS = 2_000;
export const TIMEOUT_MS = 600_000;

/** What re-scoring costs a lead: qualification's price `qualification.assessment` (its prices.ts). */
export const RESCORE_CREDITS_PER_LEAD = 0.2;

/** The proposal's fields, in the order the script prints them, one line each. */
export const PROPOSAL_FIELDS = [
  "name",
  "titles",
  "seniorities",
  "industries",
  "sizeRanges",
  "countries",
  "mustHaves",
  "disqualifiers",
] as const;
