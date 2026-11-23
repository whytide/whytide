// The switch LINKEDIN_CONTACT_INFO_ENABLED as this module reads it (README.md "Contact info";
// gamma-en-087), or the value a test sets through testing/. Off, the default, no "Contact info" read
// is made; switching it changes no stored row: what was found stays in use, nothing is deleted.
import { linkedinConfig } from "../../config.ts";

let given: boolean | undefined;

/** For tests (testing/): the switch's value; undefined restores the setting's. */
export function useContactInfoEnabled(next: boolean | undefined): void {
  given = next;
}

/** Whether an email lookup may read a lead's "Contact info" emails (the owner's exception, 2026-11-13). */
export const contactInfoEnabled = (): boolean =>
  given ?? linkedinConfig.LINKEDIN_CONTACT_INFO_ENABLED;
