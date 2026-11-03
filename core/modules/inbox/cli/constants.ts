// The fixed values of `pnpm inbox:export-labels` (README.md "The reply golden set").

/**
 * The exit codes: written; refused (an unknown workspace, a file the files port refused); a usage
 * error, week_invalid included. Through pnpm, any failure is 1.
 */
export const EXIT = { written: 0, refused: 1, usage: 2 } as const;
export const USAGE =
  "usage: pnpm inbox:export-labels [--workspace <id or slug>] [--week <ISO week>]";
export const OPTIONS = { workspace: { type: "string" }, week: { type: "string" } } as const;
/** The service each workspace's tenant runs act as. */
export const SERVICE = "inbox";
/** An id has an underscore and a slug none (tenancy's docs/concepts.md). */
export const ID_MARK = "_";
/** An AppError at or past it is the server's fault, thrown on; under it, a refusal printed. */
export const SERVER_ERROR = 500;
