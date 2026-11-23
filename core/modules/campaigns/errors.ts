// campaigns' codes (core/packages/platform/README.md "Errors"), each with its key in messages/en.json
// (campaigns.errors.<code>). A code a writer is given and its list does not hold is a developer's
// mistake, thrown as one (domain/steps/codes.ts).
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  /** No campaign of the workspace has the id. 404. */
  campaign_not_found: {},
  /** A sequence off its rules (domain/campaigns/sequence.ts); `details.rule` names the rule. 400. */
  campaign_sequence_invalid: {},
  /** saveVersion: the campaign is archived, so no version is saved. 409. */
  campaign_archived: { status: 409 },
  /** pauseCampaign: the campaign is not active (a draft, or paused already). 409. */
  campaign_not_active: { status: 409 },
  /** resumeCampaign: the campaign is not paused. 409. */
  campaign_not_paused: { status: 409 },
  /** createCampaign, renameCampaign: a name, trimmed, outside 1 to CAMPAIGN_NAME_MAX characters. 400. */
  campaign_name_invalid: {},
  /** launchCampaign: the campaign has left `draft` (gamma-p3-050). 409. */
  campaign_not_draft: { status: 409 },
  /** launchCampaign: a launch check fails; `details.checks` holds every check read. 409. */
  campaign_launch_blocked: { status: 409 },
  /** No enrollment of the workspace has the id. 404. */
  enrollment_not_found: {},
  /** pauseEnrollment: the enrollment is not active (paused already, or ended). 409. */
  enrollment_not_active: { status: 409 },
  /** resumeEnrollment: the enrollment is not paused. 409. */
  enrollment_not_paused: { status: 409 },
  /**
   * setApprovalMode: review_first_touches before the campaign's lock ends (gamma-p4-070);
   * `details.lockedUntil`, its end. 409.
   */
  approval_mode_locked: { status: 409 },
  /** setApprovalMode: a mode this version does not have. 400. */
  approval_mode_unavailable: { status: 400 },
});
