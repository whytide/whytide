// The person's words and the post's excerpt as the rating's model may read them (README.md "Rating";
// security §6): a link, an email address and a phone number become placeholders, and so does each
// part of the engager's name, as written. Pure.

/** The placeholders the model reads in place of what the scrub took out. */
export const SCRUBBED = { link: "[link]", email: "[email]", phone: "[phone]", name: "[name]" };

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const LINK =
  /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|io|ai|co|net|org|app|dev)\b(?:\/\S*)?/giu;
/** Groups of digits, a dot, dash or parenthesis inside, one space between; seven digits or more. */
const PHONE =
  /(?<![\p{L}\p{N}])\+?\(?\d(?:[().-]?\d)*\)?(?:\s\(?\d(?:[().-]?\d)*\)?)*(?![\p{L}\p{N}])/gu;

/** The text scrubbed, or null for none; `name` is the engager's, each part of 3 letters or more. */
export function scrub(text: string | null, name: string): string | null {
  if (text === null) return null;
  let scrubbed = text
    .replace(EMAIL, SCRUBBED.email)
    .replace(LINK, SCRUBBED.link)
    .replace(PHONE, (match) => (match.replace(/\D/g, "").length >= 7 ? SCRUBBED.phone : match));
  // As written: a lower-case word that is also a name ("will", "rose") stays.
  for (const part of name.split(/[^\p{L}'-]+/u).filter((word) => [...word].length >= 3)) {
    const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    scrubbed = scrubbed.replace(new RegExp(`(?<!\\p{L})${escaped}(?!\\p{L})`, "gu"), SCRUBBED.name);
  }
  return scrubbed;
}
