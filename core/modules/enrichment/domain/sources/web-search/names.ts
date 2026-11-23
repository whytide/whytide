// How web-search reads a name (docs/concepts.md "A company known only by name"): a name that is no
// company makes no search; two names are compared cleaned, in lower case, accents folded,
// punctuation dropped and the legal forms at the end dropped, so that "Blue Harbor Labs Ltd." and
// "blue harbor labs" are one. Pure.
import {
  APOSTROPHES,
  LEGAL_FORMS,
  MARKS,
  NAME_MAX,
  NAME_MIN,
  NOT_A_COMPANY_NAMES,
  NOT_A_WORD,
  SPACES,
} from "./constants.ts";

/** Lower case, accents folded, spaces trimmed and collapsed. */
export function folded(text: string): string {
  return text.normalize("NFKD").replace(MARKS, "").toLowerCase().replace(SPACES, " ").trim();
}

/**
 * The name as two names are compared: folded, apostrophes dropped, other punctuation a space, and
 * the legal forms at its end dropped while a word is left before them.
 */
export function cleanName(text: string): string {
  const words = folded(text).replace(APOSTROPHES, "").replace(NOT_A_WORD, " ").trim().split(" ");
  while (words.length > 1 && LEGAL_FORMS.includes(words.at(-1) ?? "")) words.pop();
  return words.join(" ");
}

/** The cleaned name without its spaces, as a host's first label is compared with it. */
export const squeezed = (text: string): string => cleanName(text).replaceAll(" ", "");

/**
 * No company's name: shorter than NAME_MIN or longer than NAME_MAX, nothing left once cleaned, or
 * one of NOT_A_COMPANY_NAMES, folded or cleaned ("Self-Employed.", "Freelance").
 */
export function isNotACompany(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < NAME_MIN || trimmed.length > NAME_MAX) return true;
  const clean = cleanName(trimmed);
  return (
    clean === "" || [folded(trimmed), clean].some((form) => NOT_A_COMPANY_NAMES.includes(form))
  );
}
