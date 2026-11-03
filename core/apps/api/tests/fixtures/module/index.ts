// A module's index.ts as the host loads one (README "Modules"), for the host's tests only: an `api`,
// its codes and actions, and a workspaceResolver that knows one membership in one workspace.
import type { WorkspaceResolver } from "../../../src/workspace.ts";

export { errors, FixtureApi as api, permissions } from "./fixture.controller.ts";

export const FIXTURE_WORKSPACE = "wsp_fixture_a";

export const workspaceResolver: WorkspaceResolver = async ({ workspace }) =>
  workspace === FIXTURE_WORKSPACE
    ? { workspaceId: FIXTURE_WORKSPACE, membershipId: "mem_fixture_a", role: "Owner" }
    : null;
