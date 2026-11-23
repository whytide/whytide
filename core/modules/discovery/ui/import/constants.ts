// The import screen's numbers (README.md "The screen"): the rows the past imports show while they
// load; and where View leads goes, the lead list of one import.

/** The skeleton's rows while the past imports load. */
export const HISTORY_LINES = 3;

/** The lead list of the leads the job brought, by its id as their source's ref (View leads). */
export const leadsOf = (workspace: string, jobId: string): string =>
  `/w/${workspace}/leads?source=${encodeURIComponent(jobId)}`;
