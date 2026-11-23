// The campaign routes' shapes (README.md "Routes"), from which the api host builds the OpenAPI
// document and the web its client: the workspace's campaigns, an agent's alone (gamma-p3-065), one
// campaign with its current version's steps, a campaign's pause or resume (gamma-p3-060), and the
// editor's sequence, the campaign's name, its launch checks and its launch (gamma-p3-050), and its
// approval mode (gamma-p4-070). Ids, codes, numbers, instants, delays and the campaign's name, which
// the workspace gives it: no person's data. No schema or description here uses a setting's value,
// only its default: the document is the same whatever the environment sets (README.md "Settings").
import { z } from "zod";
import { APPROVAL_MODE_MAX, APPROVAL_MODES } from "../domain/approval-mode/constants.ts";
import {
  CAMPAIGN_PAUSE_REASONS,
  CAMPAIGN_STATUSES,
  MAX_STEP_DELAY_BUSINESS_DAYS,
  MAX_STEPS,
  SEQUENCE_ACTIONS,
  STEP_CONDITIONS,
} from "../domain/campaigns/constants.ts";
import { stepDelay } from "../domain/campaigns/sequence.ts";
import { ID_MAX } from "../domain/constants.ts";
import { LAUNCH_CHECK_CODES, LAUNCH_CHECKS } from "../domain/launch/constants.ts";

const time = z.iso.datetime();

export const campaignParams = z.strictObject({ campaignId: z.string().min(1).max(ID_MAX) });

const campaign = z.strictObject({
  id: z.string(),
  /** Empty for the seeded campaign, which the screens name with a message key. */
  name: z.string(),
  status: z.enum(CAMPAIGN_STATUSES),
  /** The member whose accounts the campaign sends from; the Owner for the seeded one. */
  ownerUserId: z.string(),
  /** The agent it was made for (gamma-p3-065), whose leads it enrolls; null for the seeded one. */
  playbookId: z.string().nullable(),
  /** The current version's number, which new enrollments join; null before the first. */
  versionNo: z.int().nullable(),
  stepCount: z.int(),
  launchedAt: time.nullable(),
});

/** The list's filter: with `playbookId`, that agent's campaign alone (one at most). */
export const campaignsQuery = z.strictObject({
  playbookId: z.string().min(1).max(ID_MAX).optional(),
});
export type CampaignsQuery = z.infer<typeof campaignsQuery>;

export const campaignsResponse = z.strictObject({ campaigns: z.array(campaign) });
export type CampaignsResponse = z.infer<typeof campaignsResponse>;

/** A version's step, by position. */
const step = z.strictObject({
  position: z.int(),
  /** A key of STEP_KEYS (domain/campaigns/constants.ts), given by action and order. */
  stepKey: z.string(),
  action: z.enum(SEQUENCE_ACTIONS),
  channel: z.enum(["linkedin", "email"]),
  delay: stepDelay,
  /** The fallback's condition, on its emails only; absent on every other step (gamma-p3-060). */
  condition: z.enum(STEP_CONDITIONS).optional(),
});
export type StepResponse = z.infer<typeof step>;

/**
 * A campaign's approval mode (gamma-p4-070): the mode set, the one in force now (review_everything
 * until the lock ends, whatever is set) and the end of the lock, the creation plus 7 days.
 */
export const approvalModeResponse = z.strictObject({
  mode: z.enum(APPROVAL_MODES),
  effectiveMode: z.enum(APPROVAL_MODES),
  lockedUntil: time,
});
export type ApprovalModeResponse = z.infer<typeof approvalModeResponse>;

/**
 * The mode to set: any text the route takes, so that a mode this version lacks answers
 * approval_mode_unavailable rather than a validation's 400.
 */
export const approvalModeBody = z.strictObject({
  mode: z.string().min(1).max(APPROVAL_MODE_MAX),
});
export type ApprovalModeBody = z.infer<typeof approvalModeBody>;

export const campaignResponse = campaign.extend({
  /** The current version's steps by position. */
  steps: z.array(step),
  approvalMode: approvalModeResponse,
  limits: z
    .strictObject({
      maxStepDelayBusinessDays: z
        .int()
        .describe(
          `A later step's longest delay after the step before, in business days, ${MAX_STEP_DELAY_BUSINESS_DAYS.default} by default`,
        ),
    })
    .describe("The limits the server is configured with, which the sequence editor shows"),
});
export type CampaignResponse = z.infer<typeof campaignResponse>;

/**
 * The editor's list (domain/campaigns/edit.ts): each step's action, and its delay in business days
 * after the step before, which the connection request, the first message and, with the fallback,
 * the first email take from their place; `emailFallback` puts the fallback's condition on every
 * email. The rules are validateSequence's: a list off one is 400 campaign_sequence_invalid.
 */
export const sequenceBody = z.strictObject({
  steps: z
    .array(
      z.strictObject({
        action: z.enum(SEQUENCE_ACTIONS),
        delayBusinessDays: z.int().optional(),
      }),
    )
    .min(1)
    .max(MAX_STEPS),
  emailFallback: z.boolean(),
});
export type SequenceBody = z.infer<typeof sequenceBody>;

/** The version saved, or the current one when the steps were its own: its number and steps. */
export const sequenceResponse = z.strictObject({ versionNo: z.int(), steps: z.array(step) });
export type SequenceResponse = z.infer<typeof sequenceResponse>;

/** A new name, trimmed, 1 to CAMPAIGN_NAME_MAX characters (renameCampaign checks it). */
export const renameBody = z.strictObject({ name: z.string() });
export type RenameBody = z.infer<typeof renameBody>;
export const renameResponse = z.strictObject({ id: z.string(), name: z.string() });
export type RenameResponse = z.infer<typeof renameResponse>;

/** Every launch check read now, in order, the passing ones too: `code` null exactly when it passes. */
export const launchChecksResponse = z.strictObject({
  checks: z.array(
    z.strictObject({
      check: z.enum(LAUNCH_CHECKS),
      ok: z.boolean(),
      code: z.enum(LAUNCH_CHECK_CODES).nullable(),
    }),
  ),
});
export type LaunchChecksResponse = z.infer<typeof launchChecksResponse>;

/** A launched campaign: active, with its launch time. */
export const launchResponse = z.strictObject({
  id: z.string(),
  status: z.literal("active"),
  launchedAt: time,
});
export type LaunchResponse = z.infer<typeof launchResponse>;

/** A campaign's pause or resume: its status and its pause, set exactly while paused. */
export const campaignPauseResponse = z.strictObject({
  id: z.string(),
  status: z.enum(CAMPAIGN_STATUSES),
  pausedReason: z.enum(CAMPAIGN_PAUSE_REASONS).nullable(),
  pausedAt: time.nullable(),
});
export type CampaignPauseResponse = z.infer<typeof campaignPauseResponse>;
