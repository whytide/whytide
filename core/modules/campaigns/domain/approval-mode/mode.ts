// A campaign's effective mode and its lock (README.md "The approval mode"), pure: review_everything
// until the lock ends, whatever the campaign's mode says, then that mode; an unknown mode, or an
// instant that is not one, reads as review_everything (fail closed). The lock is the campaign's
// creation plus REVIEW_EVERYTHING_DAYS, and nothing moves it.
import { MS_PER_DAY } from "../constants.ts";
import {
  APPROVAL_MODES,
  type ApprovalMode,
  REVIEW_EVERYTHING,
  REVIEW_EVERYTHING_DAYS,
} from "./constants.ts";

/** A campaign as the mode reads it. */
export type ModeOfCampaign = {
  readonly approvalMode: string;
  readonly reviewLockedUntil: Date;
};

/** The mode the campaign is in at `at` (the file's header). */
export function effectiveMode(campaign: ModeOfCampaign, at: Date): ApprovalMode {
  // Not `<`: a time that is no number (an invalid Date) holds the lock too.
  const unlocked = at.getTime() >= campaign.reviewLockedUntil.getTime();
  if (!unlocked || !isApprovalMode(campaign.approvalMode)) return REVIEW_EVERYTHING;
  return campaign.approvalMode;
}

/** The campaign's mode as the routes answer it: set, in force at `at`, and the end of its lock. */
export function modeOf(
  campaign: { readonly approvalMode: ApprovalMode; readonly reviewLockedUntil: Date },
  at: Date,
): { mode: ApprovalMode; effectiveMode: ApprovalMode; lockedUntil: Date } {
  const { approvalMode: mode, reviewLockedUntil: lockedUntil } = campaign;
  return { mode, effectiveMode: effectiveMode(campaign, at), lockedUntil };
}

/** Whether the value is one of the modes this version has. */
export const isApprovalMode = (value: unknown): value is ApprovalMode =>
  typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);

/** The end of the lock of a campaign created at `createdAt`. */
export const reviewLockedUntilOf = (createdAt: Date): Date =>
  new Date(createdAt.getTime() + REVIEW_EVERYTHING_DAYS * MS_PER_DAY);
