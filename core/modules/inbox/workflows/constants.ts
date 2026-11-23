// The workflows' constants (README.md "The store", "The reply mail", "Replies from the inbox"),
// beside their reader, workflows.ts, in Temporal's sandbox.

/** The store's one attempt: a file read, one run, a file delete; Temporal retries a failed one. */
export const STORE_TIMEOUT = "1 minute";
/**
 * The reply mail's one attempt: two runs, a users read and the port's send, whose SMTP waits add up
 * to 50 seconds at most; Temporal retries a failed one.
 */
export const MAIL_TIMEOUT = "1 minute";
/** A reply's begin or settle: a run, and a request file written or deleted. */
export const REPLY_TIMEOUT = "1 minute";
/** linkedin's send activity and its check, as campaigns' sender calls them: a check and a call. */
export const SEND_ACTIVITY_TIMEOUT = "2 minutes";
/**
 * The send activity started within a minute of its scheduling, as campaigns' (beta-p4-040): one
 * that waits longer for a worker fails unstarted, the outcome unknown, and the check follows.
 */
export const SEND_START_TIMEOUT = "1 minute";
/** One attempt: a send retried would need the check first, which the workflow asks for itself. */
export const SEND_ATTEMPTS = 1;
/**
 * The checks after an unknown outcome, each after its wait (domain/reply/settle.ts); the reply
 * stays `sending` after the last, for the runbook (docs/runbook.md "A reply left Sending").
 */
export const REPLY_CHECKS = 3;
/** A reply draft's writer: up to two model calls; its failure mark, a database write. */
export const DRAFT_TIMEOUTS = { write: "3 minutes", mark: "10 seconds" } as const;
/** The reply drafts' sweep: every 15 minutes; each of its steps is one database read or write. */
export const DRAFT_SWEEP = { every: "15 minutes", timeout: "1 minute" } as const;
/**
 * A reply's classifier: two runs and up to two model calls; its fallback, past the classifier's
 * attempts, one run with campaigns' action (gamma-p4-040).
 */
export const CLASSIFY_TIMEOUTS = { classify: "2 minutes", fallback: "1 minute" } as const;
