// The classifier's values (README.md "The classifier"; gamma-p4-040), beside their readers in this
// folder, the agent's schemas (schemas/classify.ts) and the subscriber (events.ts). Plain values:
// the agent's task file imports them through its schemas.

/**
 * INBOX_CLASSIFY_SUGGEST_BELOW's default (settings.ts, README.md "Settings"): a model's answer under
 * this confidence is stored suggested, and campaigns acts on it only for opt_out.
 */
export const SUGGEST_BELOW = { default: 0.7 } as const;
/** The thread's last messages before the reply that the model reads as context (not in the sources). */
export const CLASSIFY_THREAD_MESSAGES = 6;
/**
 * A text's characters the model reads at most: the whole reply as LinkedIn takes it (8,000), and the
 * start of each earlier message (not in the sources).
 */
export const CLASSIFY_TEXT_MAX = { reply: 8_000, thread: 1_000 } as const;
/** A return date more than this many days after the reply's day is dropped (not in the sources). */
export const RETURN_DATE_MAX_DAYS = 90;
export const MS_PER_DAY = 86_400_000;
/** inbox_classify_reply's id is `<CLASSIFY_WORKFLOW>:<workspaceId>:<messageId>`: one run per reply. */
export const CLASSIFY_WORKFLOW = "inbox.classify";
/** Where a label came from: the store's phrases, the model, or the fallback of a failed call. */
export const CLASSIFY_ORIGINS = ["phrase", "model", "fallback"] as const;
export type ClassifyOrigin = (typeof CLASSIFY_ORIGINS)[number];
/** A phrase's label is certain; a fallback's says nothing. */
export const PHRASE_CONFIDENCE = 1;
export const FALLBACK_CONFIDENCE = 0;
/**
 * The 15 labels of RB-13.2.1, which V1 writes: the table's CHECK takes them beside the 7 of campaigns'
 * REPLY_ACTION_LABELS, 20 values, as not_now and not_interested are in both.
 */
export const LATER_LABELS = [
  "interested_meeting",
  "interested_info",
  "question",
  "objection_price",
  "objection_timing",
  "objection_competitor",
  "objection_no_need",
  "not_now",
  "referral",
  "not_interested",
  "unsubscribe",
  "ooo_autoreply",
  "bounce_system",
  "neutral_social",
  "hostile_or_spam_complaint",
] as const;
