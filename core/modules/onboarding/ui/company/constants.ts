// The Company Knowledge screen's tunable values (README "The screen"), beside the code that reads them.
import { DRAFT_RUN_MS } from "../../domain/constants.ts";

/** The cards the loading state shows as skeletons, as many as the form's, and their lines. */
export const SKELETON_CARDS = ["about", "offer", "market", "voice"] as const;
export const SKELETON_LINES = 4;

/** The record asked for again while a run fetches or drafts. */
export const POLL_MS = 2_000;
/**
 * How long a run may fetch or draft before the screen calls it stuck (docs/runbook.md): twenty
 * minutes, more than the fetch and a drafter's attempt (DRAFT_RUN_MS).
 */
export const STUCK_MS = DRAFT_RUN_MS.stuck;
/** The codes of a run that read its pages but failed to draft (README "The drafter"). */
export const DRAFTER_CODES = ["ai_failed", "draft_failed", "draft_empty"] as const;
/** The bytes of a megabyte, as the documents' limit is said. */
export const MEGABYTE = 1024 * 1024;
