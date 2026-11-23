// The agents' screens' fixed values (README "Screens"), beside the code that reads them: the routes
// they call, playbooks' own and the three they read of icp, signals and tenancy, the addresses they
// link to, the codes the sources' card acts on and each status's tone. No import of the web: the
// module's build compiles this file, and only the web compiles the screens.
import type { errors } from "../errors.ts";

/** playbooks' routes (README "Routes"). */
export const PLAYBOOKS_PATH = "/v1/workspaces/{workspaceId}/playbooks";
export const PLAYBOOK_PATH = "/v1/workspaces/{workspaceId}/playbooks/{playbookId}";
export const SOURCES_PATH = "/v1/workspaces/{workspaceId}/playbooks/{playbookId}/sources";
export const CHECK_PATH = "/v1/workspaces/{workspaceId}/playbooks/{playbookId}/sources/check";

/** icp's audiences, the default first; signals' sources; tenancy's members, who own the agents. */
export const AUDIENCES_PATH = "/v1/workspaces/{workspaceId}/icp/audiences";
export const SIGNAL_SOURCES_PATH = "/v1/workspaces/{workspaceId}/signals/sources";
export const MEMBERS_PATH = "/v1/workspaces/{workspaceId}/tenancy/members";

/** The list's segment under /w/{ws}, the agent's page under it (ui/nav.ts). */
export const AGENTS_SEGMENT = "agents";
export const agentsScreen = (workspace: string): string => `/w/${workspace}/${AGENTS_SEGMENT}`;
export const agentScreen = (workspace: string, playbookId: string): string =>
  `${agentsScreen(workspace)}/${playbookId}`;

/** icp's ICP screen, where an audience is made, and signals' Sources screen, where a source is. */
export const icpScreen = (workspace: string): string => `/w/${workspace}/icp`;
export const sourcesScreen = (workspace: string): string => `/w/${workspace}/sources`;

/** The codes the sources' card acts on, checked against errors.ts: a renamed code fails the typecheck. */
export const SOURCE_CODES_SHOWN = {
  checkerMissing: "playbook_source_checker_missing",
  inUse: "playbook_source_in_use",
} as const satisfies Record<string, keyof typeof errors>;

/** The tone of each status's badge (the kit's BadgeTone): one reads, one waits, one is done. */
export const STATUS_TONES = { active: "success", paused: "warning", archived: "neutral" } as const;
