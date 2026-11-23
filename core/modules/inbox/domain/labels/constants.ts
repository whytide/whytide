// A reply's labels (README.md "API", "Screen"), beside their readers in this folder.

/**
 * Beta's two words, as the table's enum reply_label: since gamma-p4-055 each follows the thread
 * owner's class (word.ts), so that beta-p7-030's export keeps them.
 */
export const REPLY_LABELS = ["positive", "not_positive"] as const;
export type ReplyLabelValue = (typeof REPLY_LABELS)[number];

/** The one class whose beta word is positive; the six others are not_positive. */
export const POSITIVE_CLASS = "interested";

/** The class whose default action takes a return date, the reply's classification's. */
export const RETURN_DATE_CLASS = "out_of_office";
