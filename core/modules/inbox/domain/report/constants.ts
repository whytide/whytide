// The reply numbers' constants (README.md "The report"; gamma-p7-060), beside their readers: what a
// touch, a human reply, a positive event and a pair are, the windows and the targets of gamma's
// "Done when" (roadmaps/03-gamma.md).

/** linkedin's send log kinds that touch a lead: a connection request and a message, no withdrawal. */
export const TOUCH_KINDS = ["invite", "message"] as const;
/** contacts' source label of a lead the signals found: the rates count these leads only. */
export const SIGNAL_SOURCE = "signal";
/** The channel whose rate this part reads: LinkedIn's (the email rate waits for the email phase). */
export const LINKEDIN_CHANNEL = "linkedin";
/** A reply under one of these labels is no human reply (requirements/11 §3.2, notes). */
export const NOT_HUMAN_LABELS = ["out_of_office", "bounce"] as const;
/** beta's word that stands for the positive class (labels/) on a row with no class. */
export const BETA_POSITIVE = "positive";
/** The class whose agreement is a share of the owners' replies (RB-13.2.2: when in doubt, suppress). */
export const OPT_OUT_CLASS = "opt_out";
/** A lead's positive event counts once in this many days (requirements/11 §2.1, rolling). */
export const POSITIVE_REPEAT_DAYS = 90;
/** Under this many pairs of an owner's label and a classification, the agreement is too_few. */
export const AGREEMENT_MIN_REPLIES = 30;
/** An ISO week's number is two digits, `2026-W04`. */
export const WEEK_DIGITS = 2;
/** gamma's "Done when": the LinkedIn reply rate, positive conversations, the classifier's two. */
export const TARGETS = Object.freeze({
  replyLinkedin: 0.06,
  positiveConversations: 1,
  f1Interested: 0.93,
  optOutShare: 0.99,
});
