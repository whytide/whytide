// The opt-out phrases (README.md "Decided here"; RB-13.2.2 and RB-25.3.3, reduced to a list), beside
// their reader, match.ts. English only; no model decides. "stop" and "remove me" are the roadmap's;
// the rest are not in the sources: "stop" asked for mid-reply ("Please stop messaging me") from the
// review of beta-p5-010.

/** Phrases that suppress the person wherever they stand in a reply, as whole words. */
export const OPT_OUT_PHRASES = [
  "remove me",
  "unsubscribe",
  "opt out",
  "do not contact",
  "don't contact me",
  "not interested, remove",
  "stop messaging me",
  "stop contacting me",
  "stop sending me",
] as const;

/**
 * Replies that suppress only as the whole reply ("Please stop."): elsewhere the words are often an
 * invitation ("Please stop by our booth on Tuesday").
 */
export const OPT_OUT_REPLIES = ["please stop"] as const;

/**
 * The word that suppresses only as a reply's first word, the whole reply included ("Stop.", "STOP,
 * please"): elsewhere it is rarely a request ("can't stop thinking about it", "non-stop").
 */
export const STOP_WORD = "stop";

/** The apostrophes folded to the straight one before matching: left and right single quotes, and the modifier letter. */
export const FOLDED_APOSTROPHES = ["‘", "’", "ʼ"] as const;
