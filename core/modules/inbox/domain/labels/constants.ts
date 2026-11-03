// A reply's labels (README.md "Screen"), as the table's enum reply_label: the tester's one click.
export const REPLY_LABELS = ["positive", "not_positive"] as const;
export type ReplyLabelValue = (typeof REPLY_LABELS)[number];
