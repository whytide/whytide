// The text's format gates (docs/security.md "The gates"; security §6): no placeholder left, a
// length within the channel's range, no phrase of the red lines (false familiarity, a fake reply or
// forward, false urgency, briefs RB-10.2.1). Pure; each answers its issues, none for a pass.
import type { GateIssue } from "../../schemas/writer.ts";
import { words } from "./grounding.ts";

/** The characters a text must have, both counted in. */
export type Limits = { readonly min: number; readonly max: number };

/** A template's leftovers: `{{first_name}}`, `{company}`, `[Name]`, `<name>`, INSERT. */
const PLACEHOLDER = /\{\{[^}\n]*\}\}|\{[^{}\n]*\}|\[[^\]\n]*\]|<[^<>\n]*>|\bINSERT\b/gu;

/** A fake reply or forward: a subject's `Re:`, `Fw:` or `Fwd:` opening the text or a line. */
const FAKE_THREAD = /^[ \t]*(?:re|fwd?)[ \t]*:/gimu;

/** Matched as whole words, case, accents and marks aside (words()). */
const RED_LINES = [
  // False familiarity: a talk that never happened.
  "as we discussed",
  "as discussed",
  "as promised",
  "as per our conversation",
  "per our conversation",
  "following up on our call",
  "following our call",
  "when we spoke",
  "since we last spoke",
  "great to meet you",
  "great meeting you",
  "nice to meet you",
  "good to catch up",
  "like we talked about",
  "as i mentioned",
  // A fake thread: a message that was never sent.
  "following up on my last message",
  "following up on my previous message",
  "my last message",
  "my previous message",
  "bumping this",
  "circling back",
  // False urgency.
  "last chance",
  "act now",
  "act fast",
  "today only",
  "only today",
  "ends today",
  "ends tonight",
  "expires today",
  "limited time",
  "hurry",
  "don't miss out",
  "before it's too late",
  "final notice",
  "urgent",
];

/** Every placeholder left in the text, each once. */
export function placeholderIssues(text: string): GateIssue[] {
  const found = new Set(text.match(PLACEHOLDER) ?? []);
  return [...found].map((placeholder) => ({ gate: "placeholders", placeholder }));
}

/** The text's characters, as a textarea counts them, outside the limits. */
export function lengthIssues(text: string, { min, max }: Limits): GateIssue[] {
  const { length } = text;
  return length < min || length > max ? [{ gate: "length", length, min, max }] : [];
}

/** Every red-line phrase the text holds, as the list writes it, and a fake thread's subject. */
export function redLineIssues(text: string): GateIssue[] {
  const said = ` ${words(text)} `;
  const phrases = RED_LINES.filter((phrase) => said.includes(` ${words(phrase)} `));
  const subjects = (text.match(FAKE_THREAD) ?? []).map((subject) => subject.trim());
  return [...new Set([...subjects, ...phrases])].map((phrase) => ({ gate: "red_lines", phrase }));
}
