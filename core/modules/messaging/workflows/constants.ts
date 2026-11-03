// The workflows' timeouts and the sweep's interval (README.md "The workflow"). Plain values: the
// workflows' sandbox imports them.

/** The writer's attempt, up to six model calls, and the failure mark's, a database write. */
export const DRAFT_TIMEOUTS = { write: "5 minutes", mark: "10 seconds" } as const;
/** The sweep: every hour; each of its steps is one database read or write. */
export const SWEEP = { every: "1 hour", timeout: "1 minute" } as const;
