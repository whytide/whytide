// The ICP screen's fixed values (README "The screen"), beside the code that reads them; the draft's
// waits, which the script shares, are domain/constants.ts's. No import of the web: the module's build
// compiles this file, and only the web compiles the screens.
import type { draftErrors } from "../../errors.ts";

/** The draft's route, under which `/accept` and `/discard` are its review's (README "Routes"). */
export const DRAFT_PATH = "/v1/workspaces/{workspaceId}/icp/draft";

/** The audiences' list and create, and one audience, under which `/criteria` is its criteria's. */
export const AUDIENCES_PATH = "/v1/workspaces/{workspaceId}/icp/audiences";
export const AUDIENCE_PATH = "/v1/workspaces/{workspaceId}/icp/audiences/{icpId}";

/** The screen's address names the chosen audience, `?audience=<icpId>`; without it, the default. */
export const AUDIENCE_PARAM = "audience";

/** The screen's address of an audience, on the screen's own path. */
export const audienceHref = (icpId: string): string =>
  `?${new URLSearchParams({ [AUDIENCE_PARAM]: icpId })}`;

/** The Company screen's segment under /w/{ws}, where Company Knowledge is drafted from the website. */
export const COMPANY_SEGMENT = "company";

/** The workspace's Company screen, which the draft card links to while Company Knowledge is empty. */
export const companyScreen = (workspace: string): string => `/w/${workspace}/${COMPANY_SEGMENT}`;

/** The draft's codes the card acts on, checked against errors.ts: a renamed code fails the typecheck. */
export const CARD_CODES = {
  notEmpty: "icp_not_empty",
  none: "icp_draft_none",
} as const satisfies Record<string, keyof typeof draftErrors>;
