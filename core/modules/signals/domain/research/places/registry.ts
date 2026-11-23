// The registry of source types (README.md "Web research"): every places/<id>.ts, imported by the
// generated list, registers itself with definePlace as it loads, so importing this file at start fills
// it, or fails on a duplicate. By a path the compiler does not follow, as sources/registry.ts does.
import { type Place, registeredPlaces } from "./_contract.ts";

export type { Place };

const list = "./places.generated.ts";
await import(list);

/** The registered source types, sorted by id: the plan's input, in one stable order. */
export function listPlaces(): readonly Place[] {
  return [...registeredPlaces().values()].sort((a, b) => a.id.localeCompare(b.id, "en"));
}

/** The source type with the id, or undefined for one off the list. */
export const placeOf = (id: string): Place | undefined => registeredPlaces().get(id);
