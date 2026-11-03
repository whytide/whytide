// identity's test helpers (README.md "Testing"), `@whytide/identity/testing`, in test files only:
// useIdentityClient(asRole("app")) makes the module's commands run in the test file's schema, after
// withTestDb() of @whytide/db/testing; tenancy's useTenancyClient does the same for the users and
// memberships identity reaches through tenancy. smokeSignIn is the smoke step (tests/smoke.ts), which
// the api's tests run against a started api, once runInvite, `pnpm invite`, made the first workspace.
export { runInvite } from "../cli/invite.ts";
export { useClient as useIdentityClient } from "../domain/store.ts";
export { smokeSignIn } from "../tests/smoke.ts";
