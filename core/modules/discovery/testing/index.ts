// discovery's test helpers (README.md "Testing"), `@whytide/discovery/testing`, for tests only:
// useDiscoveryClient(asRole("app")) makes the module's own runs use the test file's schema too;
// useContactsCommands({ … }) stands in for contacts' commands in the import's run, to inject a fault.
export { useContactsCommands } from "../domain/import/run.ts";
export { useClient as useDiscoveryClient } from "../domain/store.ts";
