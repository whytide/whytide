// The list of source types (README.md "Web research"; gamma-wr-040): a source type, called a place in
// the code since `source` and `kind` are taken, is a file of this folder that calls definePlace. The
// list ships with the product and is the same for every tenant: an entry says where a kind of page is
// found and what it shows, and names no trade, no country and no language. A new entry is a new file;
// no central list exists (coding §3): `scripts/kinds-generate.ts` writes places.generated.ts, which
// imports every file, as it writes the list of source kinds. The registry is a module-level map
// filled as the files load.
import { AppError } from "@whytide/platform";
import { errors } from "../../../errors.ts";
import { PAGE_KINDS, type PageKind, PLACE_TEXT_MAX } from "../constants.ts";

const PLACE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export type PlaceDefinition = {
  /** snake_case, the file's name: the id a plan names it by and a query keeps. */
  readonly id: string;
  /** The key of its label in messages/en.json, `signals.places.<id>.label`. */
  readonly labelKey: string;
  /** What a page of this type shows, in plain words, for the plan; no trade, country or language. */
  readonly shows: string;
  /** How such a page is found by a web search, in plain words, for the plan. */
  readonly finding: string;
  /** What the page is for the run's next step: a company's own site, a list of companies, or a notice. */
  readonly pageKind: PageKind;
};
export type Place = PlaceDefinition & { readonly source: string };

const places = new Map<string, Place>();

/**
 * Registers a source type when its file loads. An id off snake_case, a label key or a text off its
 * form, a page kind off the list, or an id off the file's name is signal_place_invalid; an id two files
 * declare is signal_place_duplicate, `details.sources` naming both files.
 */
export function definePlace(definition: PlaceDefinition, source: string): PlaceDefinition {
  const { id, labelKey, shows, finding, pageKind } = definition;
  const invalid = (reason: string) =>
    new AppError(errors.signal_place_invalid, { details: { id, source, reason } });
  if (typeof id !== "string" || !PLACE.test(id)) throw invalid("an id in snake_case");
  if (!new RegExp(`/${id}\\.[jt]s$`).test(source)) throw invalid("the file's name");
  if (labelKey !== `signals.places.${id}.label`) throw invalid("the label key of its id");
  for (const text of [shows, finding]) {
    if (typeof text !== "string" || text.trim() === "" || text.length > PLACE_TEXT_MAX) {
      throw invalid(`a text of 1 to ${PLACE_TEXT_MAX} characters`);
    }
  }
  if (!PAGE_KINDS.includes(pageKind)) throw invalid("a page kind of the list");
  const registered = places.get(id);
  if (registered !== undefined) {
    const details = { id, sources: [registered.source, source] };
    throw new AppError(errors.signal_place_duplicate, { details });
  }
  places.set(id, Object.freeze({ ...definition, source }));
  return definition;
}

/** Every registered source type by its id, in the order the files loaded (the generated list's). */
export const registeredPlaces = (): ReadonlyMap<string, Place> => places;
