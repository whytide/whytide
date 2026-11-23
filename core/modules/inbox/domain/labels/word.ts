// Beta's word for the thread owner's class (README.md "The reply golden set"; gamma-p4-055), pure:
// positive for interested, not_positive for the six others, the pair the table's CHECK
// reply_labels_class_label holds, so that beta-p7-030's export keeps its two words.
import type { ReplyActionLabel } from "@whytide/campaigns";
import { POSITIVE_CLASS, type ReplyLabelValue } from "./constants.ts";

export const betaWord = (classLabel: ReplyActionLabel): ReplyLabelValue =>
  classLabel === POSITIVE_CLASS ? "positive" : "not_positive";
