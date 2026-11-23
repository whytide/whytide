// The run's files under the workspace's raw/ (docs/data.md): its pages, a posts kind's pages of posts
// with their requests and its posts' pages of engagers, and for each candidate kept for a read, the
// request linkedin_read_profile reads and the profile it writes; the size of a
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
/**
 * linkedin_read_profile's refusals that stop the reading, the run then failing with the code: the
 * account disconnected, or paused or held by its retry_at since the read was reserved (beta-p6-020),
 * or stopped by a kill switch since then (beta-p6-040), which no next candidate would pass either.
 */
export const READING_ENDS: readonly string[] = Object.freeze([
  "linkedin_account_disconnected",
  "account_paused",
  "linkedin_rate_limited",
  "platform_stopped",
  "workspace_stopped",
  "account_stopped",
]);

/** The key of the member id in contacts' providerRefs: campaigns' MEMBER_REF_KEY, the vendor's. */
export const MEMBER_REF_KEY = "unipile";

/** The run's folder: every end deletes what is under it. */
export const runFolder = (runId: string): string => `raw/signals/${runId}/`;

/** A page of posts' request file and page file, as linkedin_read_posts's input names them. */
export const postsKeys = (runId: string, page: number) => ({
  requestKey: `${runFolder(runId)}posts/${page}.request.json`,
  rawKey: `${runFolder(runId)}posts/${page}.json`,
});

/** A page of the engagers of the run's `post`th post, from 1. */
export const engagersKey = (runId: string, post: number, page: number): string =>
  `${runFolder(runId)}posts/${post}/${page}.json`;

/** A candidate's request file and profile file, as linkedin_read_profile's input names them. */
export const profileKeys = (runId: string, candidateId: string) => ({
  requestKey: `${runFolder(runId)}profiles/${candidateId}.request.json`,
  rawKey: `${runFolder(runId)}profiles/${candidateId}.json`,
});
