// The alerts workflow's constants (README "Alerts"), beside their reader, workflows.ts, in Temporal's
// sandbox: plain values only.

/** The alerts' check: two reads and one insert across the organizations. */
export const ALERT_CHECK_TIMEOUT = "1 minute";
/**
 * One alert's mail: a few reads per workspace of the organization, then the port's send to each
 * Owner, whose SMTP waits add up to 50 seconds at most each.
 */
export const ALERT_MAIL_TIMEOUT = "5 minutes";
/** One alert's tries raised after its mail failed: one read and one update. */
export const ALERT_FAIL_TIMEOUT = "1 minute";
