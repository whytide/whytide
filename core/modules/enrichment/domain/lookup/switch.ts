// The UK and EU switch as the lookup reads it (the owner's decision of 2026-11-13):
// ENRICHMENT_PERSONAL_EMAIL_EU_UK, or the value a test sets through testing/. Switching it changes
// what the readers answer and what a lookup keeps, never a stored row.
import { settings } from "../../settings.ts";

let given: boolean | undefined;

/** For tests (testing/): the switch's value; undefined restores the setting's. */
export function usePersonalEmailEuUk(next: boolean | undefined): void {
  given = next;
}

export const personalEmailEuUk = (): boolean => given ?? settings.ENRICHMENT_PERSONAL_EMAIL_EU_UK;
