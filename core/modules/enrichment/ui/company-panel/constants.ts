// The company panel's fixed values (README.md "The lead page"), beside the code that reads them: the
// route it calls, how often and how long it reads again while a run works, and how a date reads. No
// import of the web: the module's build compiles this file, and only the web compiles the panel.

/** enrichment's lead route: GET the facts, POST a run (README.md "The lead page"). */
export const LEAD_PATH = "/v1/workspaces/{workspaceId}/enrichment/leads/{personId}";
/** While a run is queued or running, the panel reads the route again this often… */
export const POLL_INTERVAL_MS = 3_000;
/** …for this long at most, then stops and offers Refresh. */
export const POLL_LIMIT_MS = 60_000;
/** A provenance's date and the last run's: the day. */
export const DATE_FORMAT = { dateStyle: "medium" } as const;
