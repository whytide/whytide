// contacts' test helpers (README.md "Testing"), `@whytide/contacts/testing`, in test files only:
// useHashSalt(salt) gives the hashes a fixed salt in place of HASH_SALT, never a real one, so that a
// test runs with no secret in its environment or in a file; useContactsClient(asRole("app")) makes
// the export's own runs use the test file's schema too.
export { useSalt as useHashSalt } from "../domain/hash.ts";
export { useClient as useContactsClient } from "../domain/store.ts";
