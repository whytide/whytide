// The place list's build (scripts/places-build.ts): GeoNames' three files, the only ones it reads,
// and the columns it keeps of each (https://download.geonames.org/export/dump/readme.txt).

/** The files, by what they hold, as GeoNames names them. */
export const GEONAMES_FILES = {
  places: "cities15000.txt",
  divisions: "admin1CodesASCII.txt",
  countries: "countryInfo.txt",
} as const;

/** cities15000.txt's columns kept: the name, its ASCII form, the country, the division, people. */
export const PLACE_COLUMNS = { name: 1, ascii: 2, country: 8, division: 10, population: 14 };
/** admin1CodesASCII.txt's columns: `CC.code`, the name, its ASCII form. */
export const DIVISION_COLUMNS = { code: 0, name: 1, ascii: 2 };
/** countryInfo.txt's column of the ISO 3166-1 alpha-2 code; its comment lines start with `#`. */
export const COUNTRY_COLUMN = 0;

/** What the first line credits (NOTICE.md). */
export const SOURCE_CREDIT = "GeoNames (https://www.geonames.org/), CC BY 4.0";
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const USAGE =
  "usage: pnpm -F contacts places:build <folder> [--date YYYY-MM-DD] [--out <file>]";
