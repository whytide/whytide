// The place list (README "The place list", gamma-en-075): data/places.tsv.gz, GeoNames' places of
// 15,000 people or more and their first-level divisions, loaded once per process when first used.
// The file sits beside the module's sources; the build runs from dist/, one folder deeper, so both
// places are tried. Names are looked up by their key (countries.ts), the name's and the ASCII
// name's. A test gives a list of its own with usePlaces.
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  PLACES_COMMENT,
  PLACES_DIVISION,
  PLACES_FILE,
  PLACES_PLACE,
  PLACES_SEPARATOR,
} from "./constants.ts";

/** A first-level division: its country and its GeoNames code within it (`MA`, `08`). */
export type Division = { readonly country: string; readonly division: string };
export type Place = Division & { readonly population: number };
export type PlaceList = {
  /** The comment lines, the first naming the source and the download date. */
  readonly header: readonly string[];
  readonly divisions: ReadonlyMap<string, readonly Division[]>;
  readonly places: ReadonlyMap<string, readonly Place[]>;
};

const CANDIDATES = [`../${PLACES_FILE}`, `../../${PLACES_FILE}`];
let loaded: PlaceList | undefined;

/** The place list, read and indexed by `key` once. */
export function placeList(key: (name: string) => string): PlaceList {
  if (loaded !== undefined) return loaded;
  const file = CANDIDATES.map((path) => new URL(path, import.meta.url)).find((url) =>
    existsSync(url),
  );
  if (file === undefined) throw new Error(`contacts: the place list ${PLACES_FILE} is missing`);
  loaded = parsePlaces(gunzipSync(readFileSync(file)).toString("utf8"), key);
  return loaded;
}

/** For tests (testing/): a list's text in place of the file's; undefined reads the file again. */
export function usePlaces(text: string | undefined, key: (name: string) => string): void {
  loaded = text === undefined ? undefined : parsePlaces(text, key);
}

/** The list's text, indexed: each record under its name's key and its ASCII name's. */
export function parsePlaces(text: string, key: (name: string) => string): PlaceList {
  const header: string[] = [];
  const divisions = new Map<string, Division[]>();
  const places = new Map<string, Place[]>();
  const add = <T>(index: Map<string, T[]>, names: readonly string[], value: T) => {
    for (const name of new Set(names.filter((given) => given !== "").map(key))) {
      if (name === "") continue;
      const list = index.get(name);
      if (list === undefined) index.set(name, [value]);
      else list.push(value);
    }
  };
  for (const line of text.split("\n")) {
    if (line.startsWith(PLACES_COMMENT)) {
      header.push(line);
      continue;
    }
    const [tag, ...fields] = line.split(PLACES_SEPARATOR);
    if (tag === PLACES_DIVISION) {
      const [country = "", division = "", name = "", ascii = ""] = fields;
      add(divisions, [name, ascii], { country, division });
    } else if (tag === PLACES_PLACE) {
      const [name = "", ascii = "", country = "", division = "", population = "0"] = fields;
      add(places, [name, ascii], { country, division, population: Number(population) });
    }
  }
  return { header, divisions, places };
}
