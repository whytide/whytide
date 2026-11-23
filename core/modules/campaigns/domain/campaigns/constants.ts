// The campaigns' values (README.md "Campaigns and versions"; F08 §5.2, §5.4): the seeded campaign
// beta's template becomes, the closed list of step keys messaging's STEP_KINDS maps by their
// strings, and the bounds of a sequence, which sequence.ts checks.
import {
  FALLBACK_AFTER_DAYS,
  FIRST_MESSAGE_DELAY_HOURS,
  MIN_MINUTES_AFTER_ACCEPTANCE,
  TEMPLATE_ID,
  TEMPLATE_VERSION,
} from "../template/constants.ts";

/** The seeded campaign's key_ref: beta's template id, which enrollments carry as template_id. */
export const SEEDED_CAMPAIGN_KEY = TEMPLATE_ID;
/** A campaign's first version_no; the seeded campaign's version 1 is beta's template. */
export const FIRST_VERSION_NO = TEMPLATE_VERSION;
/** created_by of what no user made: the seeded campaign and its version 1. */
export const SYSTEM_AUTHOR = "system";

/**
 * The roles of campaigns.manage (permissions.ts): who writes every campaign, another member's and
 * the seeded one included (README.md "Decided here"); the campaign's page asks it too.
 */
export const CAMPAIGNS_MANAGE_ROLES = ["Owner", "Admin"] as const;

/** campaign_status (data model §5.6); gamma-p3-060 pauses an active one and resumes it. */
export const CAMPAIGN_STATUSES = ["draft", "active", "paused", "completed", "archived"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
/** campaign_pause_reason: a member's pause, or the bounce rate's (wired by a later task). */
export const CAMPAIGN_PAUSE_REASONS = ["user", "bounce_rate"] as const;
export type CampaignPauseReason = (typeof CAMPAIGN_PAUSE_REASONS)[number];

/** A sequence's actions: a withdrawal is the system's step, never a sequence's. */
export const SEQUENCE_ACTIONS = ["invite", "message", "email"] as const;
export type SequenceAction = (typeof SEQUENCE_ACTIONS)[number];
/** step_channel. */
export type StepChannel = "linkedin" | "email";
/** Each action's channel. */
export const ACTION_CHANNELS = {
  invite: "linkedin",
  message: "linkedin",
  email: "email",
} as const satisfies Record<SequenceAction, StepChannel>;

/**
 * The step keys by action, in order, given at save: the first email is email_1, the second LinkedIn
 * message follow_up_1. A closed list (not in the sources): messaging's STEP_KINDS maps these
 * strings.
 */
export const STEP_KEYS = {
  invite: ["connect"],
  message: ["message_1", "follow_up_1", "follow_up_2"],
  email: ["email_1", "email_2", "email_3"],
} as const satisfies Record<SequenceAction, readonly string[]>;

/** At most this many steps: one connection request, three LinkedIn messages, three emails. */
export const MAX_STEPS = 7;
/** A later step's delay after the step before it, in business days (F08 §5.2)… */
export const MIN_STEP_DELAY_BUSINESS_DAYS = 1;
/**
 * …and at most CAMPAIGNS_MAX_STEP_DELAY_BUSINESS_DAYS, whose default this is (not in the sources;
 * settings.ts, README.md "Settings"). The editor shows the value the campaign's answer carries.
 */
export const MAX_STEP_DELAY_BUSINESS_DAYS = { default: 30 } as const;
/** A campaign's name, trimmed, at most this many characters. */
export const CAMPAIGN_NAME_MAX = 80;

/** The connection request's delay: due as the enrollment is made; not editable. */
export const ENROLLMENT_DELAY = { anchor: "enrollment" } as const;
/** The first LinkedIn message's delay, beta's draw after the acceptance; not editable. */
export const FIRST_MESSAGE_DELAY = {
  anchor: "accepted",
  unit: "hours",
  min: FIRST_MESSAGE_DELAY_HOURS.min,
  max: FIRST_MESSAGE_DELAY_HOURS.max,
  minMinutes: MIN_MINUTES_AFTER_ACCEPTANCE,
} as const;

/**
 * step_condition: the only condition gamma has, the email fallback's (gamma-p3-060): the step goes
 * while the connection request is not accepted, and is skipped the moment it is.
 */
export const FALLBACK_CONDITION = "invite_not_accepted_within";
export const STEP_CONDITIONS = [FALLBACK_CONDITION] as const;
export type StepCondition = (typeof STEP_CONDITIONS)[number];
/** The fallback's first email: FALLBACK_AFTER_DAYS calendar days after the invitation, fixed. */
export const FALLBACK_DELAY = {
  anchor: "invite_sent",
  unit: "days",
  value: FALLBACK_AFTER_DAYS,
} as const;

/** The rules of validateSequence, in the order they are checked; details.rule names one. */
export const SEQUENCE_RULES = [
  "step_count",
  "step_action",
  "connect_first",
  "connect_once",
  "channel_limit",
  "first_message",
  "step_delay",
  "fallback",
] as const;
export type SequenceRule = (typeof SEQUENCE_RULES)[number];
