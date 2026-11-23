// The writer's scorer's values (score.ts; beta-p7-040): the copy of messaging's colleague phrases,
// which tests/evals.test.ts keeps equal to the module's list, and the run of words a sequence step's
// text may not share with an earlier text of its step; the copy of the act phrases (gamma-p3-075),
// which the email writer's scorer reads too. Plain values; nothing imported.

/**
 * Messaging's COLLEAGUE_SIGNAL_PHRASES (core/modules/messaging/domain/gates/constants.ts), copied, since
 * a scorer imports no module: refused as whole words, case and marks aside, each also with its last
 * word in the plural.
 */
export const COLLEAGUE_SIGNAL_PHRASES = [
  "your colleague",
  "your coworker",
  "your co-worker",
  "your teammate",
  "someone on your team",
  "someone from your team",
  "people at your company",
  "others at your company",
  "your boss",
  "your manager",
] as const;

/** The words in a row a step's text may not share with an earlier text of its <step> (no_repeat). */
export const REPEAT_RUN_WORDS = 8;

/**
 * Messaging's SIGNAL_ACT_PHRASES (core/modules/messaging/domain/gates/constants.ts), copied, since a
 * scorer imports no module: words that name a signal's act rather than its topic, refused as whole
 * words, case and marks aside, on every channel.
 */
export const SIGNAL_ACT_PHRASES = [
  "saw you liked",
  "noticed you liked",
  "see you liked",
  "you liked my post",
  "you liked our post",
  "you reacted",
  "your reaction to",
  "your reaction on",
  "saw you commented",
  "you commented on",
  "saw your comment",
  "your comment on",
  "thanks for engaging",
  "thanks for liking",
  "thanks for the like",
  "thanks for commenting",
  "thanks for your comment",
  "thanks for reacting",
  "engaged with my post",
  "engaged with our post",
  "viewed my profile",
  "visited my profile",
  "looked at my profile",
] as const;
