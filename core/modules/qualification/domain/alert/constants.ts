// The Hot alert's constants (README "The Hot alert"), beside their readers, mail.ts and the module's
// events.ts: the workflow's id and the lead's address in the web app.

/** qualification_hot_alert's id is `<HOT_ALERT_WORKFLOW>:<workspaceId>:<eventId>`: one run per entry. */
export const HOT_ALERT_WORKFLOW = "qualification.hot_alert";
/** The web app's origin: the api's variable, which the worker reads too. Empty: no link. */
export const ORIGIN_VARIABLE = "APP_PUBLIC_ORIGIN";
/** A workspace's pages in the web app sit under `/w/<workspaceId>`. */
export const WORKSPACE_PATH = "/w";
/** A lead's page under its workspace's: `leads/<personId>` (contacts' lead page). */
export const LEADS_PATH = "leads";
