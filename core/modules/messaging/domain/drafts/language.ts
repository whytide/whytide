// The language check (README.md "The writer", "Decided here"; gamma-p3-070, "English only"): before
// any model call, writeDraft holds back the draft of a lead whose profile is clearly in another
// language, so that a member writes it by hand. A heuristic in code (not in the sources): the lead's
// headline, title and own comments, as whole words after the gates' words(), against the stopwords of
// English and of the six other languages of briefs RB-1.2.9, each language by its distinct words (a
// name said three times, "Uber" or "Las Vegas", is one word); or a profile whose letters are mostly
// outside the Latin script. A short or mixed profile is written in English. textLanguage, the same
// check on any texts, names the language: a reply is written in its conversation's (inbox-reply-draft,
// domain/replies/write.ts). Pure.
import type { Dossier } from "../../schemas/dossier.ts";
import { LANGUAGE_MIN_HITS, LANGUAGE_STOPWORDS, type TextLanguage } from "../gates/constants.ts";
import { words } from "../gates/grounding.ts";

export type ProfileLanguage = "english" | "other";

const LISTS = Object.fromEntries(
  Object.entries(LANGUAGE_STOPWORDS).map(([language, list]) => [
    language,
    new Set(list.split(/\s+/u).filter((word) => word !== "")),
  ]),
);
const { english: ENGLISH = new Set<string>(), ...OTHERS } = LISTS;

/** `other` when another language is clear in the lead's own words; `english` otherwise. */
export function profileLanguage(dossier: Dossier): ProfileLanguage {
  const { headline, title } = dossier.lead;
  const texts = [headline, title, ...dossier.whyNow.map(({ comment }) => comment)].filter(
    (text): text is string => text !== null,
  );
  return textLanguage(texts) === "english" ? "english" : "other";
}

/**
 * The texts' language: `other` when most letters are outside the Latin script; else the language
 * with the most different words of its list, at least LANGUAGE_MIN_HITS and more than English's;
 * else `english`, a short or mixed text included.
 */
export function textLanguage(texts: readonly string[]): TextLanguage {
  const said = texts.join("\n");
  const letters = said.match(/\p{L}/gu)?.length ?? 0;
  const latin = said.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (latin * 2 < letters) return "other";
  const tokens = texts.flatMap((text) => words(text).split(" ")).filter((word) => word !== "");
  /** The different words of this list in the texts: a word said again counts once. */
  const hits = (list: ReadonlySet<string>) =>
    new Set(tokens.filter((token) => list.has(token))).size;
  const english = hits(ENGLISH);
  let found: { language: TextLanguage; hits: number } = { language: "english", hits: english };
  for (const [language, list] of Object.entries(OTHERS)) {
    const count = hits(list);
    if (count >= LANGUAGE_MIN_HITS && count > found.hits) {
      found = { language: language as TextLanguage, hits: count };
    }
  }
  return found.language;
}
