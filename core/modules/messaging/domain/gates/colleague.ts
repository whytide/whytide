// The colleague-signal gate (docs/security.md "The two layers of colleague privacy"; beta's rules we
// keep, briefs RB-21.1.2): a text never points at a colleague of the person, so it never carries a
// colleague's signal. It refuses a phrase of COLLEAGUE_SIGNAL_PHRASES, its last word also in the
// plural, and another person of the same company in the workspace named by first and last name
// together; a first name alone is too common to refuse. Whole words after words(), so case, accents
// and the marks around a phrase do not matter and a phrase inside longer words is no hit. Pure; it
// answers its issues, each the words that hit as the text wrote them, none for a pass.
import type { GateIssue } from "../../schemas/writer.ts";
import { COLLEAGUE_SIGNAL_PHRASES } from "./constants.ts";
import { words } from "./grounding.ts";

/** A colleague as contacts' colleaguesOf answers one: names only. */
export type Colleague = { readonly firstName: string | null; readonly lastName: string | null };

/** A word of the text as the gate compares it, with the span of the text it comes from. */
type Token = { readonly word: string; readonly start: number; readonly end: number };

/** A run of letters, marks and digits: a word of the text, before words() splits it further. */
const WORD = /[\p{L}\p{M}\p{N}]+/gu;
/** English plurals: a consonant and y (company), a sibilant (boss, coach); else an s. */
const CONSONANT_Y = /[^aeiou]y$/u;
const SIBILANT = /(?:s|x|z|ch|sh)$/u;

/** The plural of an English word, as the phrases need it. */
export function plural(word: string): string {
  if (CONSONANT_Y.test(word)) return `${word.slice(0, -1)}ies`;
  return SIBILANT.test(word) ? `${word}es` : `${word}s`;
}

/** Each phrase's words, then the same with the last word in the plural. */
const PHRASES: readonly (readonly string[])[] = COLLEAGUE_SIGNAL_PHRASES.flatMap((phrase) => {
  const said = split(phrase);
  const last = said.at(-1) ?? "";
  return [said, [...said.slice(0, -1), plural(last)]];
});

/** Every phrase or colleague's full name the text holds, once each, in the text's order. */
export function colleagueIssues(text: string, colleagues: readonly Colleague[]): GateIssue[] {
  const names = colleagues.flatMap(({ firstName, lastName }) => {
    const [first, last] = [split(firstName ?? ""), split(lastName ?? "")];
    return first.length > 0 && last.length > 0 ? [[...first, ...last]] : [];
  });
  const byFirst = new Map<string, (readonly string[])[]>();
  for (const sequence of [...PHRASES, ...names]) {
    const [head = ""] = sequence;
    byFirst.set(head, [...(byFirst.get(head) ?? []), sequence]);
  }
  const tokens = tokensOf(text);
  const hits = new Map<string, string>();
  tokens.forEach(({ word, start }, index) => {
    for (const sequence of byFirst.get(word) ?? []) {
      const end = tokens[index + sequence.length - 1]?.end;
      const matches = sequence.every((part, offset) => tokens[index + offset]?.word === part);
      const key = sequence.join(" ");
      if (matches && end !== undefined && !hits.has(key)) hits.set(key, text.slice(start, end));
    }
  });
  return [...hits.values()].map((phrase) => ({ gate: "colleague_signal", phrase }));
}

/** The text's words as words() writes them, each with the span of the text it comes from. */
function tokensOf(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(WORD)) {
    const start = match.index;
    const end = start + match[0].length;
    for (const word of split(match[0])) tokens.push({ word, start, end });
  }
  return tokens;
}

/** A value's words as the gates compare them (words()), none for an empty one. */
function split(value: string): string[] {
  return words(value)
    .split(" ")
    .filter((word) => word !== "");
}
