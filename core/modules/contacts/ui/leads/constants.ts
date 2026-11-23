// The lead list's tunable values, beside the code that reads them.

/** The loading state's rows: as many as fill the first screen. */
export const LOADING_ROWS = 8;

/**
 * The codes Add lead shows under the LinkedIn profile URL (add-lead.tsx): a URL that is no profile,
 * an erased person's, and a person who is a lead already.
 */
export const URL_CODES: readonly string[] = [
  "linkedin_url_invalid",
  "person_erased",
  "lead_exists",
];
