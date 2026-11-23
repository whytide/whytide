// The draft's waits (README "The draft"), which the script and the screen share, the audiences'
// fixed values and who writes them (README "Decided here"), which the commands, the routes and the
// screen share, the default of the audiences' limit settings.ts reads (README "Settings"), which
// the screen never uses, and what holds the automatic draft back (README "The automatic draft"). No
// import: the screen and settings.ts read them too.

/**
 * How often the script and the screen read the ICP while the worker drafts, and for how long at
 * most: longer than the drafter's three attempts of up to three minutes each (workflows/constants.ts).
 */
export const DRAFT_POLL_MS = 2_000;
export const DRAFT_TIMEOUT_MS = 600_000;

/**
 * ICP_MAX_AUDIENCES_PER_WORKSPACE's default (settings.ts, README "Settings"): the audiences a
 * workspace holds, its default included; unset, up to three agents with an audience each, the
 * default, and room for replacements (not in the sources; gamma-p3-020). Set, 1 or more, no
 * maximum.
 */
export const AUDIENCES_PER_WORKSPACE = { default: 10 } as const;

/** A new audience's name, trimmed, in characters (`POST …/icp/audiences`). */
export const AUDIENCE_NAME_MAX = 80;

/** An audience's id in a path or a query: an `icp_<ULID>` is far shorter. */
export const ID_MAX = 64;

/** `created_by` of a row a service principal's run made: the worker's or the script's first read. */
export const SYSTEM_CREATOR = "system";

/**
 * The roles of icp.manage (permissions.ts): who writes every audience, the default and another
 * member's included (README "Decided here"); the screen asks it too.
 */
export const ICP_MANAGE_ROLES = ["Owner", "Admin"] as const;

/** The prefix of the workspace's advisory lock around an audience's create, which counts them. */
export const AUDIENCES_LOCK = "icp.audiences";

/**
 * The draft statuses that hold the automatic draft back (README "The automatic draft"): a run still
 * drafting, or a proposal waiting for review.
 */
export const AUTO_DRAFT_HELD_BY: readonly string[] = ["drafting", "drafted"];

/** The automatic draft's brief: none, the Company Knowledge alone. */
export const NO_BRIEF = "";
