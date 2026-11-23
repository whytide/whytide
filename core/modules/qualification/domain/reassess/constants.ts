// The decisions of the rules title-check-ai retired (README "The batch"), beside the query that finds
// them (index.ts).
import type { Disqualifier } from "../../schemas/assess-fit.ts";

/**
 * The people-type disqualifiers: from prompt v2 of qualification.assess-fit, the model gives one only
 * when the data clearly shows it and the ICP does not target that kind of person.
 */
export const PEOPLE_TYPE_DISQUALIFIERS = [
  "agency_or_consultant",
  "freelancer",
  "student_or_intern",
  "job_seeker",
  "recruiter",
] as const satisfies readonly Disqualifier[];

/** The first prompt version of qualification.assess-fit whose people-type disqualifiers follow the ICP. */
export const ICP_AWARE_PROMPT_VERSION = 2;
