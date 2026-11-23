// The 30-day rule's activity timeouts (README.md "The 30-day rule"). Plain values: the sandbox
// imports them.

/** The list of workspaces: one read. */
export const LIST_TIMEOUT = "1 minute";
/** A workspace's run: its candidates read, then RETENTION_MAX_PER_RUN erasures at most. */
export const RUN_TIMEOUT = "1 hour";
/** The sweep: every deleted person's erasers again, every workspace's. */
export const SWEEP_TIMEOUT = "4 hours";
/** The host's wrapper beats every 20 seconds: an attempt silent this long has lost its worker. */
export const HEARTBEAT_TIMEOUT = "1 minute";
