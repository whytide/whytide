// The message policies checked in code (README.md "The writer", "Decided here"; gamma-p3-070, gamma's
// "Build it simply"): a signal named by its topic, never by its act, on every channel; an email's
// subject; no link in a first email; no near-duplicate body from one mailbox in a day. Pure; each
// answers its issues, none for a pass. The near-duplicate issue holds a number, never another text.
import type { GateIssue } from "../../schemas/writer.ts";
import { phraseHits, split } from "./colleague.ts";
import {
  EMAIL_SUBJECT_MAX_CHARACTERS,
  EMAIL_SUBJECT_MAX_WORDS,
  NEAR_DUPLICATE_SHINGLE_WORDS,
  NEAR_DUPLICATE_THRESHOLD,
  SIGNAL_ACT_PHRASES,
  SIMILARITY_DECIMALS,
  SUBJECT_PREFIXES,
} from "./constants.ts";
import { wordCount } from "./format.ts";

const ACTS = SIGNAL_ACT_PHRASES.map(split);
/** A fake reply's or forward's opening, in any case, a space before its colon allowed. */
const PREFIX = new RegExp(
  `^(?:${SUBJECT_PREFIXES.map((p) => p.slice(0, -1)).join("|")})\\s*:`,
  "iu",
);
/** An http(s) address, `www.`, an email address, then a bare domain: a word, a dot, 2 to 24 letters. */
const LINKS = [
  /\bhttps?:\/\/[^\s<>"]+/giu,
  /\bwww\.[^\s<>"]+/giu,
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu,
  /(?<![\p{L}\p{N}.@/-])(?:[\p{L}\p{N}-]+\.)+\p{L}{2,24}(?![\p{L}\p{N}])/gu,
];
/** The marks after a link that end its sentence. */
const TRAILING = /[.,;:!?)\]'"’”]+$/u;

/** Every act phrase the text holds, once each, as the text wrote it. */
export function signalActIssues(text: string): GateIssue[] {
  return phraseHits(text, ACTS).map((phrase) => ({ gate: "signal_act", phrase }));
}

/**
 * A first email's subject, trimmed: one, of at most EMAIL_SUBJECT_MAX_WORDS words and
 * EMAIL_SUBJECT_MAX_CHARACTERS characters, on one line, opening with no prefix of
 * SUBJECT_PREFIXES. A follow-up has none: it goes in the first email's thread.
 */
export function subjectIssues(subject: string | null, first: boolean): GateIssue[] {
  const said = subject?.trim() ?? "";
  if (!first) return said === "" ? [] : [{ gate: "subject", problem: "not_allowed" }];
  if (said === "") return [{ gate: "subject", problem: "missing" }];
  const long =
    wordCount(said) > EMAIL_SUBJECT_MAX_WORDS || said.length > EMAIL_SUBJECT_MAX_CHARACTERS;
  const problems = [
    ...(long ? (["too_long"] as const) : []),
    ...(PREFIX.test(said) ? (["prefix"] as const) : []),
    ...(/[\r\n]/u.test(said) ? (["line_break"] as const) : []),
  ];
  return problems.map((problem) => ({ gate: "subject", problem }));
}

/** Every link of the texts, a first email's subject and body, once each, as written. */
export function linkIssues(texts: readonly string[]): GateIssue[] {
  const found: string[] = [];
  for (const text of texts) {
    let rest = text;
    for (const pattern of LINKS) {
      // Each link once: an address's domain is not a bare domain again.
      rest = rest.replace(pattern, (link) => {
        found.push(link.replace(TRAILING, ""));
        return " ".repeat(link.length);
      });
    }
  }
  return [...new Set(found)].map((link) => ({ gate: "links", link }));
}

/**
 * The body against the other bodies of its mailbox: an issue with the highest Jaccard similarity of
 * their word runs, at or above NEAR_DUPLICATE_THRESHOLD, rounded; none below it.
 */
export function nearDuplicateIssues(body: string, others: readonly string[]): GateIssue[] {
  const own = shingles(body);
  const highest = others.reduce(
    (most, other) => Math.max(most, similarity(own, shingles(other))),
    0,
  );
  if (highest < NEAR_DUPLICATE_THRESHOLD) return [];
  const scale = 10 ** SIMILARITY_DECIMALS;
  return [{ gate: "near_duplicate", similarity: Math.round(highest * scale) / scale }];
}

/** The text's runs of NEAR_DUPLICATE_SHINGLE_WORDS words after words(); a shorter text whole. */
export function shingles(text: string): Set<string> {
  const said = split(text);
  const size = NEAR_DUPLICATE_SHINGLE_WORDS;
  if (said.length < size) return new Set(said.length === 0 ? [] : [said.join(" ")]);
  return new Set(said.slice(0, 1 - size).map((_, i) => said.slice(i, i + size).join(" ")));
}

/** The runs both sets hold over the runs either holds; 0 when both are empty. */
export function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const shared = [...a].filter((run) => b.has(run)).length;
  const either = a.size + b.size - shared;
  return either === 0 ? 0 : shared / either;
}
