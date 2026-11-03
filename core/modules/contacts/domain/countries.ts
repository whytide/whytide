// location_country (the task's Open question, decided here): the ISO 3166-1 alpha-2 code of the
// country a location names, read from its last comma-separated part, or from the whole text: "London,
// England, United Kingdom" is GB, "San Francisco Bay Area" none. The names are ICU's English region
// names (Intl.DisplayNames: the 249 current codes and XK, no table to keep up), plus the other names
// people and LinkedIn use; a name is compared without case, accents, punctuation or "&" for "and".
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** Codes ICU names that are no country: unions, outlying regions, pseudo-locales, the unknown one. */
const NOT_COUNTRIES = new Set("AC CP CQ DG EA EU EZ IC QO TA UN XA XB ZZ".split(" "));
const ALIASES: Readonly<Record<string, string>> = {
  usa: "US",
  "united states of america": "US",
  uk: "GB",
  "great britain": "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  uae: "AE",
  "the netherlands": "NL",
  "czech republic": "CZ",
  turkey: "TR",
  "russian federation": "RU",
  korea: "KR",
  "republic of korea": "KR",
  "hong kong": "HK",
  "hong kong sar": "HK",
  macau: "MO",
  macao: "MO",
  "viet nam": "VN",
  myanmar: "MM",
  burma: "MM",
  "ivory coast": "CI",
  "cabo verde": "CV",
  "democratic republic of the congo": "CD",
  "republic of the congo": "CG",
  palestine: "PS",
};
let byName: Map<string, string> | undefined;

/** The ISO 3166-1 alpha-2 code of the country a location names, or null. */
export function countryOf(location: string | null | undefined): string | null {
  if (!location) return null;
  const names = countries();
  const last = location.split(",").at(-1) ?? "";
  return names.get(key(last)) ?? names.get(key(location)) ?? null;
}

/** A country given as a code (`de`, `DE`) or a name, as its code; null when it is neither. */
export function countryCode(value: string): string | null {
  const code = value.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(code)) return [...countries().values()].includes(code) ? code : null;
  return countryOf(value);
}

function countries(): Map<string, string> {
  if (byName !== undefined) return byName;
  const display = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
  const names = new Map<string, string>();
  for (const code of [...LETTERS].flatMap((a) => [...LETTERS].map((b) => a + b))) {
    // A withdrawn code (DD, SU, YU, …) canonicalizes to its successor, which ICU names too.
    if (NOT_COUNTRIES.has(code) || Intl.getCanonicalLocales(`und-${code}`)[0] !== `und-${code}`) {
      continue;
    }
    const name = display.of(code);
    if (name !== undefined) names.set(key(name), code);
  }
  for (const [name, code] of Object.entries(ALIASES)) names.set(key(name), code);
  byName = names;
  return names;
}

/** A name as compared: no case, accents, apostrophes or punctuation; "&" as "and", "St." as "saint". */
function key(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bst\.?\s/g, "saint ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
