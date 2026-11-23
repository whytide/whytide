// location_country (alpha's Open question, decided then; gamma-en-075): the ISO 3166-1 alpha-2 code
// of the country a location names. Country names are ICU's English region names (Intl.DisplayNames:
// the 249 current codes and XK, no table to keep up), plus the other names people and LinkedIn use;
// the rest is the place list (places.ts, README "The place list"). A name is compared by its key:
// no case, accents, punctuation or "&" for "and".
//
// The text is cleaned ("Greater" before, "Metropolitan Area", "Area", … after), then its
// comma-separated parts are read from the last to the first, each narrowing where the next may lie:
// - a country's name (or its two-letter code, in capitals) and a division's name (or a US state's or
//   Canadian province's code) are the regions a part may be; a part read before them looks only
//   within them, and never names a country;
// - a city's name ends the reading: the country of the largest place of that name in those regions,
//   unless a place of that name in another country has more than a tenth of its people;
// - a part that names nothing, or only words such as "Remote", is passed over.
// The regions left give the country when they all lie in one: "Georgia" alone, a country and a US
// state, gives none, and "Atlanta, Georgia" the US.
import {
  CANADIAN_PROVINCES,
  CITY_RIVAL_SHARE,
  LOCATION_PREFIXES,
  LOCATION_SUFFIXES,
  NO_PLACE_WORDS,
  US_STATES,
} from "./constants.ts";
import { type Division, type PlaceList, placeList, usePlaces as use } from "./places.ts";

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
const CODE = /^[A-Z]{2}$/;
const PREFIX = new RegExp(`^(?:${LOCATION_PREFIXES.join("|")})\\s+`, "i");
const SUFFIX = new RegExp(`\\s+(?:${LOCATION_SUFFIXES.join("|")})$`, "i");
const NO_PLACE = new Set(NO_PLACE_WORDS);
/** A region a part may be: a country, or a division of one. */
type Region = { readonly country: string; readonly division?: string };
let byName: Map<string, string> | undefined;
let codes: Set<string> | undefined;

/** The ISO 3166-1 alpha-2 code of the country a location names, or null. */
export function countryOf(location: string | null | undefined): string | null {
  if (!location) return null;
  const cleaned = cleanLocation(location);
  // A country's name with a comma in it ("Korea, Republic of"), read whole as before.
  const whole = cleaned.includes(",") ? countries().get(key(cleaned)) : undefined;
  if (whole !== undefined) return whole;
  const parts = cleaned.split(",").map((part) => part.trim());
  const list = placeList(key);
  let regions: readonly Region[] | null = null;
  for (const part of parts.reverse()) {
    if (part === "" || NO_PLACE.has(key(part))) continue;
    const found = regionsOf(part, regions, list);
    if (found.length > 0) {
      regions = found;
      continue;
    }
    const city = cityOf(part, regions, list);
    if (city !== undefined) return city;
  }
  const named = new Set((regions ?? []).map((region) => region.country));
  return named.size === 1 ? ([...named][0] ?? null) : null;
}

/** For tests (testing/): a place list's text in place of the file's; undefined reads the file. */
export function usePlaces(text: string | undefined): void {
  use(text, key);
}

/** A country given as a code (`de`, `DE`) or a name, as its code; null when it is neither. */
export function countryCode(value: string): string | null {
  const code = value.trim().toUpperCase();
  if (CODE.test(code)) return countryKnown(code) ? code : null;
  return countryOf(value);
}

/** The location as it is read: spaces collapsed, "Greater" before and "Area", … after dropped. */
export function cleanLocation(location: string): string {
  return location.replace(/\s+/g, " ").trim().replace(PREFIX, "").replace(SUFFIX, "").trim();
}

/** Whether the location names no place: empty, or words such as "Remote" and "EMEA" only. */
export function namesNoPlace(location: string): boolean {
  const parts = cleanLocation(location)
    .split(",")
    .map((part) => key(part))
    .filter((part) => part !== "");
  return parts.every((part) => NO_PLACE.has(part));
}

/**
 * The regions `part` may be within `within` (anywhere when null): the countries of its name or
 * code, anywhere only, and the divisions of its name or code within a country.
 */
function regionsOf(part: string, within: readonly Region[] | null, list: PlaceList): Region[] {
  const named = key(part);
  const code = CODE.test(part) ? part : undefined;
  const found: Region[] = [];
  if (within === null) {
    const country = countries().get(named) ?? (code && countryKnown(code) ? code : undefined);
    if (country !== undefined) found.push({ country });
  }
  const divisions: Division[] = [...(list.divisions.get(named) ?? []), ...divisionsOfCode(code)];
  const scopes = within === null ? null : within.filter((region) => region.division === undefined);
  for (const { country, division } of divisions) {
    if (scopes !== null && !scopes.some((region) => region.country === country)) continue;
    if (!found.some((region) => region.country === country && region.division === division)) {
      found.push({ country, division });
    }
  }
  return found;
}

/** A US state's or a Canadian province's two-letter code, as its division. */
function divisionsOfCode(code: string | undefined): Division[] {
  if (code === undefined) return [];
  const province = CANADIAN_PROVINCES[code];
  return [
    ...(US_STATES.includes(code) ? [{ country: "US", division: code }] : []),
    ...(province === undefined ? [] : [{ country: "CA", division: province }]),
  ];
}

/**
 * The country of the largest place named `part` within `within`, null when a place of that name in
 * another country has more than CITY_RIVAL_SHARE of its people; undefined when none is named so.
 */
function cityOf(
  part: string,
  within: readonly Region[] | null,
  list: PlaceList,
): string | null | undefined {
  const inside = (place: Region) =>
    within === null ||
    within.some(
      (region) =>
        region.country === place.country &&
        (region.division === undefined || region.division === place.division),
    );
  const places = (list.places.get(key(part)) ?? []).filter(inside);
  const [largest, ...others] = [...places].sort((a, b) => b.population - a.population);
  if (largest === undefined) return undefined;
  const rival = others.some(
    (place) =>
      place.country !== largest.country && place.population > largest.population * CITY_RIVAL_SHARE,
  );
  return rival ? null : largest.country;
}

const countryKnown = (code: string) => {
  codes ??= new Set(countries().values());
  return codes.has(code);
};

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
export function key(name: string): string {
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
