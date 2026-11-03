// The workflows' constants (README.md "The store", "The reply mail"), beside their reader,
// workflows.ts, in Temporal's sandbox.

/** The store's one attempt: a file read, one run, a file delete; Temporal retries a failed one. */
export const STORE_TIMEOUT = "1 minute";
/**
 * The reply mail's one attempt: two runs, a users read and the port's send, whose SMTP waits add up
 * to 50 seconds at most; Temporal retries a failed one.
 */
export const MAIL_TIMEOUT = "1 minute";
