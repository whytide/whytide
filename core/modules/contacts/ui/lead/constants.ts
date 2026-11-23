// The lead page's tunable values, beside the code that reads them.

/** The loading state's shimmering lines: the profile's card, the why's, the decision's beside. */
export const LOADING_LINES = [4, 3, 5] as const;

/**
 * The person's fields the header shows: the name, the title at the company and the location. The
 * latest a member edited gives the header its Edited mark (edit.tsx), else the name's source shows.
 */
export const HEADER_FIELDS = [
  "firstName",
  "lastName",
  "title",
  "companyName",
  "locationText",
] as const;

/** qualification's four verdicts, in the order the verdict dialog offers them (verdicts.tsx). */
export const VERDICTS = ["met", "partially_met", "not_met", "unknown"] as const;
/** A member's note on a verdict, in characters: qualification's MEMBER_NOTE_MAX. */
export const VERDICT_NOTE_MAX = 500;
