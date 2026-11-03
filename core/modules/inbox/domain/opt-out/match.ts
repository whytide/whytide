// The opt-out matcher (README.md "Decided here"; docs/concepts.md "Opt-out phrase"): pure, no model.
// A text and every phrase fold the same way: curly apostrophes to the straight one, then lower case,
// with any run of what is not a letter, a mark, a digit or an apostrophe inside a word as one space.
// A phrase matches as whole words anywhere: "remove me" in "Please REMOVE ME.", never in "remove
// meeting notes". "stop" matches as the reply's first word only: "STOP." and "Stop, please", never
// "can't stop thinking about it", "non-stop" or "stopwatch". A whole-reply phrase matches as the
// whole reply only: "Please stop.", never "Please stop by our booth".
import { FOLDED_APOSTROPHES, OPT_OUT_PHRASES, OPT_OUT_REPLIES, STOP_WORD } from "./constants.ts";

const APOSTROPHES = new RegExp(`[${FOLDED_APOSTROPHES.join("")}]`, "gu");
/** A straight apostrophe with no letter or digit on one side: a quote mark, not part of a word. */
const QUOTE_MARK = /(?<![\p{L}\p{M}\p{N}])'|'(?![\p{L}\p{M}\p{N}])/gu;
const SEPARATORS = /[^\p{L}\p{M}\p{N}']+/gu;

/** The text folded: lower case, its words separated by one space, apostrophes inside words kept. */
export function foldText(text: string): string {
  return text
    .replace(APOSTROPHES, "'")
    .replace(QUOTE_MARK, " ")
    .toLowerCase()
    .replace(SEPARATORS, " ")
    .trim();
}

const PHRASES = OPT_OUT_PHRASES.map((phrase) => ` ${foldText(phrase)} `);
const REPLIES = new Set(OPT_OUT_REPLIES.map(foldText));
const STOP = foldText(STOP_WORD);

/**
 * Whether the text asks to stop, in any case and with any punctuation: "stop" as its first word, a
 * whole-reply phrase as all of it, or a phrase of the list anywhere, as whole words.
 */
export function matchesOptOut(text: string): boolean {
  const folded = foldText(text);
  if (folded.split(" ", 1)[0] === STOP || REPLIES.has(folded)) return true;
  return PHRASES.some((phrase) => ` ${folded} `.includes(phrase));
}
