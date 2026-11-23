// A lead's names as the patterns read them (README "The sources reply, website and pattern";
// gamma-en-085): lower case, accents folded, letters only; the first given name and the whole family
// name. Pure. The cases, as tests/email-sources.test.ts asserts them:
//
// | Given          | Family          | Cleaned               |
// |----------------|-----------------|-----------------------|
// | Jürgen         | Strauß          | jurgen, strauss       |
// | José María     | García-López    | jose, garcialopez     |
// | Zoë            | van der Berg    | zoe, vanderberg       |
// | Łukasz         | Søndergård      | lukasz, sondergard    |
// | Mary-Kate      | O'Brien         | marykate, obrien      |
// | 李              | Wang            | (none), wang          |

/** The letters NFKD leaves whole, folded as they are written in an address. */
const FOLD: Readonly<Record<string, string>> = {
  ß: "ss",
  ẞ: "ss",
  æ: "ae",
  Æ: "ae",
  œ: "oe",
  Œ: "oe",
  ø: "o",
  Ø: "o",
  ł: "l",
  Ł: "l",
  đ: "d",
  Đ: "d",
  ð: "d",
  Ð: "d",
  þ: "th",
  Þ: "th",
  ı: "i",
};
const FOLDED = new RegExp(`[${Object.keys(FOLD).join("")}]`, "g");
const MARKS = /\p{M}/gu;

/** A name lower case, its accents folded, letters a to z only; empty for none. */
export function cleanName(name: string): string {
  return name
    .replace(FOLDED, (letter) => FOLD[letter] ?? "")
    .normalize("NFKD")
    .replace(MARKS, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/** The lead's names for a pattern: the first given name, the whole family name. */
export type Names = { readonly first: string; readonly last: string };

/** The first word of the given names and the whole family name, cleaned; empty when none is left. */
export function namesOf(firstName: string, lastName: string): Names {
  const [given = ""] = firstName.trim().split(/\s+/);
  return { first: cleanName(given), last: cleanName(lastName) };
}
