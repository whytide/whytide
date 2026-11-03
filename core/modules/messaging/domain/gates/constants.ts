// The gates' values (README.md "The writer", "Decided here"; beta-p3-020): the characters an edited or
// approved text may have, and the phrases of the colleague-signal gate. Plain values; nothing
// imported.

/** The most characters a message may have: above it, no text passes and no edit is saved. */
export const MESSAGE_HARD_LIMIT = 1_900;

/** The fewest characters a text has: any message, and a lead's note. */
export const TEXT_MIN_CHARACTERS = 1;
/** The fewest characters of a sequence step's note: an empty one is an invitation with no note. */
export const STEP_NOTE_MIN_CHARACTERS = 0;

/**
 * The words that point at a colleague of the person, so at a signal of someone else at their company
 * (beta's rules we keep: "your colleague liked our post"): refused as whole words, case and marks
 * aside, each also with its last word in the plural ("your colleagues"). English only, as beta is.
 */
export const COLLEAGUE_SIGNAL_PHRASES = [
  "your colleague",
  "your coworker",
  "your co-worker",
  "your teammate",
  "someone on your team",
  "someone from your team",
  "people at your company",
  "others at your company",
  "your boss",
  "your manager",
] as const;
