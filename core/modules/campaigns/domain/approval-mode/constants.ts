// The approval mode's values (README.md "The approval mode"; F13 §3.3; RB-14.2.1, two modes of its
// four), beside the code that reads them: mode.ts, requirement.ts, set.ts and ../steps/actions.ts.
import type { StepDecision } from "@whytide/approvals";
import { CAMPAIGNS_MANAGE_ROLES } from "../campaigns/constants.ts";

/**
 * campaign_approval_mode: a person approves every step, or every first touch while the campaign's
 * mode approves the follow-ups, each with its AI disclosure line (RB-20.6.1).
 */
export const APPROVAL_MODES = ["review_everything", "review_first_touches"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
/** The default (RB-25.3.3), and every campaign's mode while its lock holds. */
export const REVIEW_EVERYTHING = "review_everything" satisfies ApprovalMode;
/** The lighter mode, opt-in: a follow-up goes with the mode's approval. */
export const REVIEW_FIRST_TOUCHES = "review_first_touches" satisfies ApprovalMode;
/** A campaign is in review_everything this many days from its creation, whatever is chosen. */
export const REVIEW_EVERYTHING_DAYS = 7;

/**
 * What a step needs before it goes (../steps/actions.ts approvalRequired): nothing (a withdrawal),
 * a person's approval, or a person's or the mode's.
 */
export const APPROVAL_REQUIREMENTS = ["none", "person", "person_or_mode"] as const;
export type ApprovalRequirement = (typeof APPROVAL_REQUIREMENTS)[number];
/** The one requirement the mode's approval meets. */
export const PERSON_OR_MODE = "person_or_mode" satisfies ApprovalRequirement;

/** approvals' origin of the mode's approval, which no person made (gamma-p4-090). */
export const MODE_ORIGIN = "approval_mode" satisfies NonNullable<StepDecision["decisionOrigin"]>;
/** approvals' item opened for the mode (openItem's approvalBy), and the one for a person. */
export const BY_MODE = "mode" satisfies StepDecision["approvalBy"];
export const BY_PERSON = "person" satisfies StepDecision["approvalBy"];

/** The roles of campaigns.approval_mode (permissions.ts): campaigns.manage's, Owner and Admin. */
export const APPROVAL_MODE_ROLES = CAMPAIGNS_MANAGE_ROLES;
/** The longest mode a request names: any other value is approval_mode_unavailable. */
export const APPROVAL_MODE_MAX = 64;

/** The steps a switch back to review_everything reads: waiting for, or holding, an approval. */
export const RETURNED_STEP_STATUSES = ["awaiting_approval", "scheduled"] as const;
