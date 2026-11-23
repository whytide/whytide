// What the kinds share for a sources CSV (README.md "Importing sources"; sources-csv-import): the label
// of a row without one, from the link the kind stores.
import { LABEL_MAX_CHARS, LINK_LABEL_START } from "./constants.ts";

/** A stored link as a label: without `https://www.`, its first LABEL_MAX_CHARS characters. */
export function linkLabel(link: string): string {
  const shown = link.startsWith(LINK_LABEL_START) ? link.slice(LINK_LABEL_START.length) : link;
  return Array.from(shown).slice(0, LABEL_MAX_CHARS).join("");
}
