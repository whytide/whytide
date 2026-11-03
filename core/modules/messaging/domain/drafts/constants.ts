// The drafts of a sequence's steps (README.md "The writer", "The workflow"; beta-p3-010): plain
// values, read by the domain, the schemas, the events and the workflows' inputs; nothing imported.

/**
 * The sequence template's step keys, as messaging needs them: what each step's draft is. A
 * connection request's note stays empty and makes no model call; the others are written.
 */
export const STEP_KINDS = {
  connect: "note",
  message_1: "first_message",
  follow_up_1: "follow_up",
  follow_up_2: "follow_up",
} as const;
export type StepKey = keyof typeof STEP_KINDS;
/** The step keys, a schema's closed list. */
export const STEP_KEYS = Object.keys(STEP_KINDS) as [StepKey, ...StepKey[]];
/** The kinds of step whose text the writer writes: the <step> block's `kind`. */
export const WRITTEN_STEP_KINDS = ["first_message", "follow_up"] as const;

/** The most earlier drafts a step's draft builds on: the template's steps before its last. */
export const EARLIER_DRAFTS_MAX = 3;

/** A draft still `drafting` this long after it was made has no run left: the sweep fails it. */
export const DRAFT_STUCK_MINUTES = 30;
export const MS_PER_MINUTE = 60_000;

/** The statuses a step's draft ends in, which messaging.step_draft_ready carries. */
export const STEP_DRAFT_ENDS = ["ready", "flagged", "failed"] as const;
export type StepDraftEnd = (typeof STEP_DRAFT_ENDS)[number];

/** The most characters an approval's text may have as given, before trimming and its gates. */
export const APPROVAL_TEXT_MAX = 4_000;
/** The decimals an edit ratio keeps: edit_ratio's scale, decimal(4,3). */
export const EDIT_RATIO_DECIMALS = 3;
