// The classifier's eval values (README.md beside this file), beside their readers: score.ts and
// golden.ts. The ai package never imports inbox: what it needs of inbox's files is read as text
// (score.ts) or copied here, a test keeping each copy equal to inbox's file.
import { join } from "node:path";

/** A golden case's scripted answer, never used: `--cases` runs live only. */
export const GOLDEN_FAKE = "the fake has no answer for a real reply";

const inbox = join(import.meta.dirname, "..", "..", "..", "..", "modules", "inbox");
/** Beta's opt-out phrases, which the system matches before the model (inbox's opt-out/match.ts). */
export const OPT_OUT_CONSTANTS = join(inbox, "domain", "opt-out", "constants.ts");
/** inbox's classifier constants, whose input bounds the copies below equal. */
export const CLASSIFY_CONSTANTS = join(inbox, "domain", "classify", "constants.ts");
/** Fewer phrases read means the file changed shape: the scorer refuses to run. */
export const OPT_OUT_PHRASES_MIN = 10;

/** inbox's CLASSIFY_THREAD_MESSAGES: the thread's last messages before the reply the model reads. */
export const CLASSIFY_THREAD_MESSAGES = 6;
/** inbox's CLASSIFY_TEXT_MAX: the characters of each text the model reads at most. */
export const CLASSIFY_TEXT_MAX = { reply: 8_000, thread: 1_000 } as const;

/** The one label positive against the rest, the golden set's beta word `positive`. */
export const POSITIVE_LABEL = "interested";
export const POSITIVE_WORD = "positive";
export const OPT_OUT_LABEL = "opt_out";
