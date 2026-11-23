// The Email panel's fixed values (README.md "The Email panel"), beside the code that reads them: the
// routes it calls. How often and how long it reads again, and how a date reads, are the company
// panel's (../company-panel/constants.ts). No import of the web: the module's build compiles this
// file, and only the web compiles the panel.

/** enrichment's email route: GET the held address and last lookup, POST "find" or "verify". */
export const EMAIL_PATH = "/v1/workspaces/{workspaceId}/enrichment/leads/{personId}/work-email";
/** enrichment's phones route (gamma-wr-100): GET the numbers a public page printed with the person, and the pages. */
export const PHONES_PATH = "/v1/workspaces/{workspaceId}/enrichment/leads/{personId}/phones";
/** credits' price list, whose `enrichment.work_email` the panel shows before "Find email". */
export const PRICES_PATH = "/v1/workspaces/{workspaceId}/credits/prices";
