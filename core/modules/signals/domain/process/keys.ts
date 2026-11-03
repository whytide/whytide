// The run's files under the workspace's raw/ (docs/data.md): its pages, and for each candidate kept
// for a read, the request linkedin_read_profile reads and the profile it writes; the size of a
// processing step, and when profiles the provider cannot read stop the reading. Plain values, which
// the workflow imports too.

/** Candidates per processing step: a page's worth, in one tenant run. */
export const PROCESS_CHUNK = 25;

/** linkedin_read_profile's refusal of a profile the provider failed on past its attempts. */
export const UNREADABLE = "linkedin_provider_error";
/**
 * Such refusals in a row that stop the reading, the run then failing with the code: a provider
 * outage must not drop every candidate left and move the watermark.
 */
export const UNREADABLE_IN_ROW_MAX = 3;

/** The run's folder: every end deletes what is under it. */
export const runFolder = (runId: string): string => `raw/signals/${runId}/`;

/** A candidate's request file and profile file, as linkedin_read_profile's input names them. */
export const profileKeys = (runId: string, candidateId: string) => ({
  requestKey: `${runFolder(runId)}profiles/${candidateId}.request.json`,
  rawKey: `${runFolder(runId)}profiles/${candidateId}.json`,
});
