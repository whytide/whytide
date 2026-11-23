// contacts' test helpers (README.md "Testing"), `@whytide/contacts/testing`, in test files only:
// useHashSalt(salt) gives the hashes a fixed salt in place of HASH_SALT, never a real one, so that a
// test runs with no secret in its environment or in a file; useContactsClient(asRole("app")) makes
// the export's own runs use the test file's schema too; createLeadByMember is the Add lead form's
// command, for privacy's test of a lead deleted and added again by hand (lead-delete-script), since
// no module calls it; useEnrichmentHold(minutes) holds a new lead that long in place of
// CONTACTS_ENRICHMENT_HOLD_MINUTES, 0 for none, so that a test selects a lead it just created
// (undefined goes back to the setting); usePlaces(text) reads a place list's text in place of
// data/places.tsv.gz (undefined reads the file again); useSharedFactSources(classes) shares the
// classes given in place of CONTACTS_SHARED_FACT_SOURCES, [] for none (undefined goes back to it);
// addSuppression is the never-contact form's command, for enrichment's safety cases of a blocked
// address (gamma-rf-040), since no module calls it.
export { useSharedClasses as useSharedFactSources } from "../domain/companies/sharing.ts";
export { usePlaces } from "../domain/countries.ts";
export { useSalt as useHashSalt } from "../domain/hash.ts";
export { useHoldMinutes as useEnrichmentHold } from "../domain/hold.ts";
export { createLeadByMember } from "../domain/lead-create.ts";
export { useClient as useContactsClient } from "../domain/store.ts";
export { addSuppression } from "../domain/suppression/entries.ts";
