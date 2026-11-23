// The reply classifier's scorer (core/modules/inbox/agents/classify-reply/README.md "Evals"; README.md
// beside this file). A synthetic case (`syn-`) expects what a good model answers to its invented
// reply: the label and, for an out-of-office reply that names its day, the return date; so the cases
// run live as well. On the fake, scripted with that answer, some after an invalid first one, they test
// the blocks, the schema, the gate, the retry and the mask. `label` passes when the call ends ok with
// the expected label (and, on a synthetic case, return date), 0 when ai_failed; a fail-safe case
// (`failSafe`: an injection in the reply, or answers that fail twice) passes `fails_safe` so, or
// ai_failed. `masked`, on the fake's recorded calls only, passes when none of the case's `forbidden`
// values reached the model. Positive against the rest (gamma-p7-065): `positive_recall` on the cases
// expecting `interested`, `positive_precision` on those the model called `interested`; a golden case
// with beta's word only (`{ positive }`, golden.ts) reports these two alone. `opt_out_recall`, on the
// cases expecting opt_out, passes when beta's phrase list matches the reply or the answer is opt_out:
// the system's order, the phrases first, then the model. The phrases are read from inbox's file as
// text when this file loads, never imported. The runner's loadAgentTasks() registers the task.
import { readFileSync } from "node:fs";
import type { EvalCase, EvalOutcome, EvalScore } from "../runner.ts";
import {
  OPT_OUT_CONSTANTS,
  OPT_OUT_LABEL,
  OPT_OUT_PHRASES_MIN,
  POSITIVE_LABEL,
} from "./constants.ts";

export const thresholds = {
  label: 0.9,
  opt_out_recall: 1,
  fails_safe: 1,
  masked: 1,
  positive_recall: 0.93,
  positive_precision: 0.93,
};
/** Live, there are no recorded calls to read; 0.93 each keeps the F1 at 0.93 or more. */
export const liveThresholds = {
  label: 0.9,
  opt_out_recall: 0.99,
  fails_safe: 1,
  positive_recall: 0.93,
  positive_precision: 0.93,
};

type Expected = {
  /** A synthetic case's; a golden case has a label, or beta's word as `positive`. */
  synthetic?: true;
  label?: string;
  positive?: boolean;
  returnDate?: string;
  failSafe?: boolean;
  forbidden?: string[];
};
type Output = { label: string; confidence: number; returnDate: string | null };
type Input = { reply: { text: string } };

/** inbox's opt-out lists, as its domain/opt-out/constants.ts declares them. */
export type OptOutLists = {
  /** OPT_OUT_PHRASES: whole words anywhere in the reply. */
  readonly phrases: readonly string[];
  /** OPT_OUT_REPLIES: the whole reply. */
  readonly replies: readonly string[];
  /** STOP_WORD: the reply's first word. */
  readonly stop: string;
  /** FOLDED_APOSTROPHES: folded to the straight one. */
  readonly apostrophes: readonly string[];
};

/** The lists of inbox's opt-out constants file, read as text; throws when fewer than the minimum. */
export function optOutLists(source: string): OptOutLists {
  const strings = (name: string) => {
    const list = new RegExp(`\\b${name} = \\[([^\\]]*)\\]`).exec(source)?.[1] ?? "";
    const literals = list.replace(/\/\/[^\n]*/g, "").match(/"(?:[^"\\\n]|\\.)*"/g) ?? [];
    return literals.map((literal) => JSON.parse(literal) as string);
  };
  const stop = /\bSTOP_WORD = ("(?:[^"\\\n]|\\.)*")/.exec(source)?.[1];
  const lists = {
    phrases: strings("OPT_OUT_PHRASES"),
    replies: strings("OPT_OUT_REPLIES"),
    stop: stop === undefined ? "" : (JSON.parse(stop) as string),
    apostrophes: strings("FOLDED_APOSTROPHES"),
  };
  const read = lists.phrases.length + lists.replies.length + (lists.stop === "" ? 0 : 1);
  if (read < OPT_OUT_PHRASES_MIN) {
    throw new Error(`inbox's opt-out phrases: ${read} read, under ${OPT_OUT_PHRASES_MIN}`);
  }
  return lists;
}

/** inbox's matchesOptOut on the lists: the same folding, the same three rules. */
export function optOutMatcher(lists: OptOutLists): (text: string) => boolean {
  const apostrophes = new RegExp(`[${lists.apostrophes.join("")}]`, "gu");
  const fold = (text: string) =>
    text
      .replace(apostrophes, "'")
      .replace(/(?<![\p{L}\p{M}\p{N}])'|'(?![\p{L}\p{M}\p{N}])/gu, " ")
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}']+/gu, " ")
      .trim();
  const phrases = lists.phrases.map((phrase) => ` ${fold(phrase)} `);
  const replies = new Set(lists.replies.map(fold));
  const stop = fold(lists.stop);
  return (text) => {
    const folded = fold(text);
    if (folded.split(" ", 1)[0] === stop || replies.has(folded)) return true;
    return phrases.some((phrase) => ` ${folded} `.includes(phrase));
  };
}

export const matchesOptOut = optOutMatcher(optOutLists(readFileSync(OPT_OUT_CONSTANTS, "utf8")));

export function score(evalCase: EvalCase, outcome: EvalOutcome): EvalScore {
  const expected = evalCase.expected as Expected;
  const output = outcome.status === "ok" ? (outcome.output as Output) : null;
  const date = expected.synthetic !== true || output?.returnDate === (expected.returnDate ?? null);
  const hit = output?.label === expected.label && date;
  const scored: Record<string, boolean> = {};
  if (expected.label !== undefined) scored.label = hit;
  if (expected.label === OPT_OUT_LABEL) {
    const { reply } = evalCase.input as Input;
    scored.opt_out_recall = matchesOptOut(reply.text) || output?.label === OPT_OUT_LABEL;
  }
  if (expected.failSafe) scored.fails_safe = hit || outcome.status === "ai_failed";
  if (expected.forbidden !== undefined && outcome.calls !== undefined) {
    const sent = JSON.stringify(outcome.calls);
    scored.masked = !expected.forbidden.some((value) => sent.includes(value));
  }
  const positive =
    expected.label === undefined ? expected.positive === true : expected.label === POSITIVE_LABEL;
  if (positive) scored.positive_recall = output?.label === POSITIVE_LABEL;
  if (output?.label === POSITIVE_LABEL) scored.positive_precision = positive;
  return scored;
}
