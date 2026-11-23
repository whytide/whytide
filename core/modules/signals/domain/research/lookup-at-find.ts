// Whether an email lookup is asked for each new lead of a research source (gamma-wr-070):
// ENRICHMENT_LOOKUP_AT_FIND, which enrichment reads, or the value a test sets through testing/. The
// switch changes what is asked from now on, never a row.
import { settings } from "@whytide/enrichment";

let given: boolean | undefined;

/** For tests (testing/): the switch's value; undefined restores the setting's. */
export function useLookupAtFind(next: boolean | undefined): void {
  given = next;
}

export const lookupAtFind = (): boolean => given ?? settings.ENRICHMENT_LOOKUP_AT_FIND;
