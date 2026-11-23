// The workflows' timeouts, the sweep's interval, its pages and their patch (README.md "The
// workflow"). Plain values: the workflows' sandbox imports them.

/** The writer's attempt, up to six model calls, and the failure mark's, a database write. */
export const DRAFT_TIMEOUTS = { write: "5 minutes", mark: "10 seconds" } as const;
/** The sweep: every hour; each of its steps is one database read or write. */
export const SWEEP = { every: "1 hour", timeout: "1 minute" } as const;
/**
 * The workspaces of one sweep run at most (gamma-p0-085, not in the sources): the run continues as
 * new after each page but the last, with its cursor and its counts (pages.ts).
 */
export const SWEEP_PAGE_SIZE = 50;
/**
 * The patch of messaging_sweep that pages the workspaces (gamma-p0-085), asked once at the run's
 * start: a run started before it replays unchanged and never continues as new.
 */
export const SWEEP_PAGES_PATCH = "sweep-pages";
