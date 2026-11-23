// The fixed values of `pnpm knowledge:draft` (README "The script"), beside the code that reads them.
import { DRAFT_RUN_MS } from "../domain/constants.ts";

export const DRAFT_USAGE =
  "usage: pnpm knowledge:draft --workspace <id or slug> [--url <https://…>] [--file <path>]... [--accept [--replace-edited]]";

/**
 * The exit codes: drafted (and accepted with --accept); refused before any write; a usage error; the
 * run failed; a later Draft superseded it; the wait ran out while the worker goes on; no workspace
 * has the id or the slug, nothing written.
 */
export const EXIT = {
  done: 0,
  refused: 1,
  usage: 2,
  failed: 3,
  superseded: 4,
  timeout: 5,
  notFound: 6,
} as const;

/**
 * The wait for the worker's run: a read of the record every two seconds, twenty minutes at most, as
 * long as the screens give a run before they call it stuck (DRAFT_RUN_MS).
 */
export const WAIT = { everyMs: 2_000, forMs: DRAFT_RUN_MS.stuck } as const;

/** The characters of a drafted text field the summary prints: its start. */
export const FIELD_START = 60;

/** The Company screen of the workspace, where a person reviews the draft. */
export const COMPANY_SCREEN = "/w/{workspace}/company";
