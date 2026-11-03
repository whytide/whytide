// A module as the host loads one (README "Modules"), for tests/host.test.ts only (alpha-p3-030): an
// `api`, an `accountApi` and their action; the fixture module's workspaceResolver answers for it.
export { GuardAccountApi as accountApi, GuardApi as api, permissions } from "./guard.controller.ts";
