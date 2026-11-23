// `pnpm -F contacts places:build <folder> [--date YYYY-MM-DD] [--out <file>]` (README "The place
// list"): GeoNames' three files in <folder> become data/places.tsv.gz, read by domain/places.ts.
// It reads those three files only and makes no network call. The download date is --date, else the
// day (UTC) the newest of the three was written. Only places and divisions of a country that
// countryInfo.txt lists are kept. The output is the same for the same files: gzip at level 9, no
// file name or time in its header. It prints counts only.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import {
  PLACES_COMMENT,
  PLACES_DIVISION,
  PLACES_FILE,
  PLACES_PLACE,
  PLACES_SEPARATOR,
} from "../domain/constants.ts";
import {
  COUNTRY_COLUMN,
  DATE,
  DIVISION_COLUMNS,
  GEONAMES_FILES,
  PLACE_COLUMNS,
  SOURCE_CREDIT,
  USAGE,
} from "./constants.ts";

/** The three files' texts, and the download date. */
export type GeonamesFiles = {
  readonly places: string;
  readonly divisions: string;
  readonly countries: string;
  readonly downloaded: string;
};
export type Built = {
  readonly text: string;
  readonly counts: { places: number; divisions: number; countries: number };
};

/** The rows of a file: CRLF or LF line ends, comment and empty lines dropped, split on tabs. */
const rows = (text: string) =>
  text
    .split(/\r?\n/)
    .filter((line) => line !== "" && !line.startsWith(PLACES_COMMENT))
    .map((line) => line.split(PLACES_SEPARATOR));
/** A field as written: no tab or line end inside. */
const clean = (value: string | undefined) => (value ?? "").replace(/[\t\r\n]+/g, " ").trim();
/** The ASCII name, empty when it is the name. */
const asciiOf = (name: string, ascii: string) => (ascii === name ? "" : ascii);

/** The place list's text from the files. */
export function buildPlaces(files: GeonamesFiles): Built {
  const countries = new Set(
    rows(files.countries)
      .map((row) => clean(row[COUNTRY_COLUMN]))
      .filter((code) => /^[A-Z]{2}$/.test(code)),
  );
  const lines = [
    `${PLACES_COMMENT} ${SOURCE_CREDIT}: ${Object.values(GEONAMES_FILES).join(", ")}, downloaded ${files.downloaded}`,
  ];
  let divisions = 0;
  for (const row of rows(files.divisions)) {
    const [country = "", code = ""] = clean(row[DIVISION_COLUMNS.code]).split(".");
    const name = clean(row[DIVISION_COLUMNS.name]);
    if (!countries.has(country) || code === "" || name === "") continue;
    const ascii = asciiOf(name, clean(row[DIVISION_COLUMNS.ascii]));
    lines.push([PLACES_DIVISION, country, code, name, ascii].join(PLACES_SEPARATOR));
    divisions += 1;
  }
  let places = 0;
  for (const row of rows(files.places)) {
    const name = clean(row[PLACE_COLUMNS.name]);
    const country = clean(row[PLACE_COLUMNS.country]);
    const population = Number.parseInt(clean(row[PLACE_COLUMNS.population]), 10);
    if (name === "" || !countries.has(country)) continue;
    const ascii = asciiOf(name, clean(row[PLACE_COLUMNS.ascii]));
    const division = clean(row[PLACE_COLUMNS.division]);
    const people = Number.isFinite(population) && population > 0 ? population : 0;
    lines.push([PLACES_PLACE, name, ascii, country, division, people].join(PLACES_SEPARATOR));
    places += 1;
  }
  return {
    text: `${lines.join("\n")}\n`,
    counts: { places, divisions, countries: countries.size },
  };
}

/** The command; the exit code: 0 written, 2 a usage error. */
export function runPlacesBuild(args: string[], print: (line: string) => void): number {
  let parsed: ReturnType<typeof parse> | undefined;
  try {
    parsed = parse(args);
  } catch {
    // an unknown option, or one without its value: the usage below
  }
  const folder = parsed?.positionals[0];
  const date = parsed?.values.date;
  if (folder === undefined || (date !== undefined && !DATE.test(date))) {
    print(USAGE);
    return 2;
  }
  const paths = Object.fromEntries(
    Object.entries(GEONAMES_FILES).map(([kind, file]) => [kind, join(folder, file)]),
  ) as Record<keyof typeof GEONAMES_FILES, string>;
  const newest = Math.max(...Object.values(paths).map((path) => statSync(path).mtimeMs));
  const downloaded = date ?? new Date(newest).toISOString().slice(0, 10);
  const read = (path: string) => readFileSync(path, "utf8");
  const built = buildPlaces({
    places: read(paths.places),
    divisions: read(paths.divisions),
    countries: read(paths.countries),
    downloaded,
  });
  const out = parsed?.values.out ?? fileURLToPath(new URL(`../${PLACES_FILE}`, import.meta.url));
  writeFileSync(out, gzipSync(built.text, { level: 9 }));
  const { places, divisions, countries } = built.counts;
  print(`places_built: ${places} places, ${divisions} divisions, ${countries} countries`);
  return 0;
}

function parse(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: { date: { type: "string" }, out: { type: "string" } },
  });
}

if (import.meta.main) {
  process.exit(runPlacesBuild(process.argv.slice(2), (line) => console.log(line)));
}
