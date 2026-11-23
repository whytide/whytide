// The campaigns' screens' fixed values (README.md "Screens"), beside the code that reads them: the
// routes they call, campaigns' own and the three they read of contacts, messaging and credits, the
// addresses they open, each status's badge tone, the codes the launch panel acts on, the sample
// leads, a new message's delay and a preview's kind and polling. No import of the web: the module's
// build compiles this file, and only the web compiles the screens.
import type { CampaignStatus } from "../domain/campaigns/constants.ts";
import type { errors } from "../errors.ts";

/** campaigns' routes (README.md "Routes"). */
export const CAMPAIGNS_PATH = "/v1/workspaces/{workspaceId}/campaigns";
export const CAMPAIGN_PATH = "/v1/workspaces/{workspaceId}/campaigns/{campaignId}";
export const SEQUENCE_PATH = "/v1/workspaces/{workspaceId}/campaigns/{campaignId}/sequence";
export const LAUNCH_CHECKS_PATH =
  "/v1/workspaces/{workspaceId}/campaigns/{campaignId}/launch-checks";
export const LAUNCH_PATH = "/v1/workspaces/{workspaceId}/campaigns/{campaignId}/launch";
export const PAUSE_PATH = "/v1/workspaces/{workspaceId}/campaigns/{campaignId}/pause";
export const RESUME_PATH = "/v1/workspaces/{workspaceId}/campaigns/{campaignId}/resume";
export const APPROVAL_MODE_PATH =
  "/v1/workspaces/{workspaceId}/campaigns/{campaignId}/approval-mode";
/** The channels whose AI disclosure line the approval mode's card shows, in order (gamma-p4-070). */
export const DISCLOSURE_CHANNELS = ["linkedin_message", "email"] as const;

/** contacts' leads, the previews' sample; messaging's drafts, the previews; credits' price list. */
export const LEADS_PATH = "/v1/workspaces/{workspaceId}/contacts/leads";
export const LEAD_DRAFTS_PATH = "/v1/workspaces/{workspaceId}/messaging/leads/{personId}/drafts";
export const DRAFT_PATH = "/v1/workspaces/{workspaceId}/messaging/drafts/{id}";
export const PRICES_PATH = "/v1/workspaces/{workspaceId}/credits/prices";

/** The list's segment under /w/{ws}, the campaign's page under it (ui/nav.ts). */
export const CAMPAIGNS_SEGMENT = "campaigns";
export const campaignsScreen = (workspace: string): string =>
  `/w/${workspace}/${CAMPAIGNS_SEGMENT}`;
export const campaignScreen = (workspace: string, campaignId: string): string =>
  `${campaignsScreen(workspace)}/${campaignId}`;
/** Where a failing launch check is fixed: linkedin's accounts page, credits' page. */
export const linkedinScreen = (workspace: string): string => `/w/${workspace}/linkedin`;
export const creditsScreen = (workspace: string): string => `/w/${workspace}/credits`;

/** The tone of each status's badge (the kit's BadgeTone). */
export const STATUS_TONES = {
  draft: "neutral",
  active: "success",
  paused: "warning",
  completed: "neutral",
  archived: "neutral",
} as const satisfies Record<CampaignStatus, string>;

/** A launch date: the day. */
export const DATE_FORMAT = { dateStyle: "medium" } as const;

/** The codes the launch panel acts on, checked against errors.ts: a renamed code fails the typecheck. */
export const LAUNCH_CODES = {
  blocked: "campaign_launch_blocked",
  notDraft: "campaign_not_draft",
} as const satisfies Record<string, keyof typeof errors>;

/** The previews' sample: the first this many leads in contacts' fit order. */
export const SAMPLE_LEADS = 20;
export const SAMPLE_SORT = "fit";

/** A message added in the editor: this many business days after the step before, until changed. */
export const NEW_MESSAGE_DELAY = 3;

/** A preview's draft: a LinkedIn message, written as its step's kind (messaging's STEP_KINDS). */
export const PREVIEW_CHANNEL = "linkedin_message";
export const PREVIEW_KINDS = {
  message_1: "first_message",
  follow_up_1: "follow_up",
  follow_up_2: "follow_up",
} as const;

/**
 * A preview read again until its writer ends, as messaging's draft panel reads a draft: after two
 * seconds, then an eighth of its age, thirty seconds at most, and no more after twenty minutes.
 */
export const PREVIEW_POLL_MS = 2_000;
export const PREVIEW_POLL_MAX_MS = 30_000;
export const PREVIEW_POLL_FOR_MS = 20 * 60_000;
export const PREVIEW_POLL_AGE_SHARE = 8;
export const MS_PER_MINUTE = 60_000;
