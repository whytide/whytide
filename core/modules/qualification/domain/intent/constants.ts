// intent-v1's numbers (README "Intent and priority"; RB-5.3.1, RB-5.3.2, F03 §6): the weights, the
// multipliers and the bounds, and the nightly decay's time and page. A change to a weight, a
// multiplier or a bound is a new scorer version with its own golden file (tests/fixtures/golden/),
// never an edit of intent-v1.json, as for fit-v1.

/** What an intent_scores row's scorer_version names. */
export const INTENT_SCORER_VERSION = "intent-v1";

/** The event kinds of the signal reader's items. */
export const INTENT_KINDS = [
  "topic_engagement",
  "competitor_engagement",
  "creator_engagement",
  "my_post_engagement",
  "post_engagement",
] as const;
/** The person's role on the post; a repost counts as a reaction. */
export const INTENT_ROLES = ["author", "comment", "reaction", "repost"] as const;
/** The roles as the weights count them, and as intent_breakdown stores them: no repost. */
export const COUNTED_ROLES = ["author", "comment", "reaction"] as const;
/** The intent classes the AI rates an event with (gamma-p5-030). */
export const INTENT_CLASSES = [
  "seeking_recommendation",
  "pain_or_complaint",
  "evaluating_or_comparing",
  "praising_competitor",
  "other",
  "generic_praise",
  "self_promotion",
  "job_seeking",
] as const;

export type IntentKind = (typeof INTENT_KINDS)[number];
export type IntentRole = (typeof INTENT_ROLES)[number];
/** A role as the weights count it: a repost is a reaction. */
export type CountedRole = (typeof COUNTED_ROLES)[number];
export type IntentClass = (typeof INTENT_CLASSES)[number];

/** The role a repost counts as. */
export const REPOST_COUNTS_AS: CountedRole = "reaction";

/**
 * Base weights, 0 to 10, by kind and role (F03 §6; post_engagement's not in the sources). A role
 * a kind does not list weighs nothing, so its item counts for nothing.
 */
export const INTENT_WEIGHTS: Readonly<
  Record<IntentKind, Readonly<Partial<Record<CountedRole, number>>>>
> = {
  topic_engagement: { author: 7, comment: 5, reaction: 3 },
  competitor_engagement: { comment: 6, reaction: 4 },
  creator_engagement: { comment: 4, reaction: 2 },
  my_post_engagement: { comment: 6, reaction: 4 },
  post_engagement: { comment: 5, reaction: 3 },
};

/**
 * The multiplier of an item's intent class (F03 §6 for seeking_recommendation and
 * pain_or_complaint, the others not in the sources).
 */
export const INTENT_CLASS_MULTIPLIERS: Readonly<Record<IntentClass, number>> = {
  seeking_recommendation: 1.5,
  pain_or_complaint: 1.4,
  evaluating_or_comparing: 1.3,
  praising_competitor: 1,
  other: 1,
  generic_praise: 0.8,
  self_promotion: 0.6,
  job_seeking: 0.6,
};

/** The days in which an item's weight halves, by kind (F03 §6). */
export const HALF_LIFE_DAYS: Readonly<Record<IntentKind, number>> = {
  topic_engagement: 14,
  competitor_engagement: 14,
  creator_engagement: 14,
  my_post_engagement: 14,
  post_engagement: 14,
};

/** The items of the last this many days count, the older none (not in the sources). */
export const INTENT_HORIZON_DAYS = 90;
/** Intent = round(INTENT_SCALE × (1 − e^(−S ÷ INTENT_SATURATION))) (RB-5.3.1). */
export const INTENT_SCALE = 100;
export const INTENT_SATURATION = 8;
/** A rated relevance counts within these bounds (RB-5.3.1). */
export const RELEVANCE_MIN = 0.3;
export const RELEVANCE_MAX = 1;
/** An unrated item's relevance and intent-class multiplier (not in the sources). */
export const UNRATED_RELEVANCE = 0.65;
export const UNRATED_MULTIPLIER = 1;
/**
 * The stacking bonus (RB-5.3.1): S gains STACKING_STEP for each distinct kind after the first
 * among the items of the last STACKING_WINDOW_DAYS, STACKING_MAX at most.
 */
export const STACKING_WINDOW_DAYS = 30;
export const STACKING_STEP = 0.15;
export const STACKING_MAX = 0.6;

/** Priority = round(0.55 × fit + 0.45 × intent) (RB-5.3.2), in percent so that the sum is exact. */
export const FIT_SHARE_PERCENT = 55;
export const INTENT_SHARE_PERCENT = 45;
export const PERCENT = 100;
/** A contribution in intent_breakdown, rounded to hundredths. */
export const HUNDREDTHS = 100;
export const PRIORITY_MAX = 100;
/**
 * The boost (RB-5.3.2): BOOST_POINTS while an item of the last BOOST_HOURS is first-party or has a
 * base weight of BOOST_MIN_WEIGHT or more (6 not in the sources).
 */
export const BOOST_POINTS = 10;
export const BOOST_HOURS = 48;
export const BOOST_MIN_WEIGHT = 6;
export const FIRST_PARTY_KINDS: ReadonlySet<IntentKind> = new Set(["my_post_engagement"]);
/** The tiers by priority (RB-5.3.2): Hot from HOT_PRIORITY, Warm from WARM_PRIORITY, else Cool. */
export const HOT_PRIORITY = 75;
/** The tier whose entry the Hot alert mails (README "The Hot alert"). */
export const HOT_TIER = "hot";
export const WARM_PRIORITY = 55;
/** The why's bullets at most, the why-now's included (F04 §8). */
export const WHY_MAX = 3;

/** The nightly decay's time of day, UTC, `HH:MM` (not in the sources). */
export const INTENT_DECAY_AT_UTC = "02:30";
/** The persons one activity of the decay recomputes, in one run. */
export const INTENT_DECAY_PAGE = 50;
/** The prefix of the person's advisory lock, which a decision and an intent update both take. */
export const PERSON_LOCK = "qualification.person";
/** The person ids one leadPriorities call takes at most. */
export const LEAD_PRIORITIES_MAX = 1000;

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
