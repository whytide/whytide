// The masker (README.md "The classifier"; docs/security.md "What the model sees"): before a text
// reaches the classifier, its links, email addresses, phone numbers and the names given (the
// person's and the thread owner's) become placeholders, as qualification's anonymizer does for a
// profile. A date stays a date: an out-of-office reply's return is what the model reads it for.
// Pure: it imports nothing.

/** What stands where each was. */
export const MASKS = {
  link: "[link]",
  email: "[email]",
  phone: "[phone]",
  name: "[name]",
} as const;
const EDGE = String.raw`(?<![\p{L}\p{N}])`;
const END = String.raw`(?![\p{L}\p{N}])`;
/** A link with its scheme or from www., or a domain followed by a path (`cal.example/noor`). */
const LINK =
  /\b(?:https?:\/\/|www\.)\S+|(?<![\p{L}\p{N}@.-])(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}\/\S*/giu;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
/** Digits and separators that may be a phone number: one when PHONE_DIGITS of them are digits. */
const PHONE = /(?<![\p{L}\p{N}])\+?\(?\d[\d \t()./-]{5,}\d(?![\p{L}\p{N}])/gu;
const PHONE_DIGITS = 7;
/** A date or a year range, which stays: `2026-11-24`, `24.11.2026`, `11/24/26`, `2026-2027`. */
const DATE =
  /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|(?:19|20)\d{2}\s*[-/]\s*(?:19|20)\d{2}/;
const SYNTAX = /[.*+?^${}()|[\]\\]/g;

const phone = (run: string) =>
  DATE.test(run) || run.replace(/\D/g, "").length < PHONE_DIGITS ? run : MASKS.phone;

/** The text's links, email addresses and phone numbers masked: the agent's schema does it to every text. */
export function maskPatterns(text: string): string {
  return text
    .normalize("NFC")
    .replace(LINK, MASKS.link)
    .replace(EMAIL, MASKS.email)
    .replace(PHONE, phone);
}

/** Each part of the names, of two letters or more, as a whole word in any case, with and without its accents. */
function namePattern(names: readonly (string | null | undefined)[]): RegExp | null {
  const parts = names.flatMap((name) => (name ?? "").normalize("NFC").split(/[\s'’-]+/));
  const plain = (part: string) => part.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
  const variants = parts.flatMap((part) => [part, plain(part)]);
  const kept = [...new Set(variants.filter((part) => /\p{L}.*\p{L}/u.test(part)))];
  if (kept.length === 0) return null;
  // The longest first, so that a part another one starts with never leaves that one's end.
  const escaped = kept.sort((a, b) => b.length - a.length).map((p) => p.replace(SYNTAX, "\\$&"));
  return new RegExp(`${EDGE}(?:${escaped.join("|")})${END}`, "giu");
}

/** The masker of one reply's texts: maskPatterns, then the names' parts. */
export function masker(names: readonly (string | null | undefined)[]): (text: string) => string {
  const name = namePattern(names);
  return (text) => {
    const masked = maskPatterns(text);
    return name === null ? masked : masked.replace(name, MASKS.name);
  };
}
