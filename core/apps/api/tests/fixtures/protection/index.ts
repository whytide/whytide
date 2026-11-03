// A module as the host loads one (README "Modules"), for tests/protection.test.ts only: its `api` and
// a workspaceResolver that makes the caller Owner of every workspace whose id starts wsp_protect_.
import type { WorkspaceResolver } from "../../../src/workspace.ts";

export { ProtectionApi as api, permissions, runs } from "./protection.controller.ts";

export const workspaceResolver: WorkspaceResolver = async ({ workspace }) =>
  workspace.startsWith("wsp_protect_")
    ? { workspaceId: workspace, membershipId: `mem_${workspace.slice(4)}`, role: "Owner" }
    : null;
