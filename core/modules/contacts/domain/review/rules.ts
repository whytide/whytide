// The rules of a review decision (docs/concepts.md "Review"), pure: Good lead with the tester's
// sentence, or Not a fit with one of the fifteen reason codes (RB-5.2.2) and, for `other`, a text.
import { AppError } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../../errors.ts";

export const REVIEW_DECISIONS = ["good_lead", "not_a_fit"] as const;
/** The ten common codes, then the five of F04 §9, as the brief lists them. */
export const REASON_CODES = [
  "company_competitor",
  "company_wrong_industry_or_type",
  "company_wrong_size",
  "company_wrong_location",
  "contact_wrong_title_or_function",
  "contact_wrong_seniority",
  "contact_known_or_duplicate",
  "data_incorrect_or_outdated",
  "signal_not_relevant",
  "other",
  "company_existing_customer",
  "company_in_open_deal",
  "contact_not_decision_maker",
  "contact_left_company",
  "bad_timing",
] as const;
/** The list's review filter: the leads without a decision. */
export const REVIEW_FILTERS = ["unreviewed"] as const;
export type ReviewDecisionKind = (typeof REVIEW_DECISIONS)[number];
export type ReasonCode = (typeof REASON_CODES)[number];
export type ReviewFilter = (typeof REVIEW_FILTERS)[number];

export const reviewInput = z.strictObject({
  personId: z.string().min(1).max(64),
  decision: z.enum(REVIEW_DECISIONS),
  reasonCode: z.enum(REASON_CODES).optional(),
  reasonText: z.string().trim().max(500).optional(),
  goodReasonText: z.string().trim().max(200).optional(),
});
type Given = Omit<z.output<typeof reviewInput>, "personId">;

/** What a decision stores: the fields of its kind, the other kind's null. */
export type DecisionFields = {
  readonly decision: ReviewDecisionKind;
  readonly reasonCode: ReasonCode | null;
  readonly reasonText: string | null;
  readonly goodReasonText: string | null;
};

/**
 * The decision's fields: Not a fit needs a code (review_reason_required) and, for `other`, a text;
 * Good lead needs its text (review_text_required); a blank text is none. A field of the other kind
 * is contacts_input_invalid naming it.
 */
export function decisionFields({ decision, reasonCode, ...given }: Given): DecisionFields {
  const reasonText = given.reasonText || null;
  const goodReasonText = given.goodReasonText || null;
  const good = decision === "good_lead";
  const misplaced = good
    ? [reasonCode !== undefined && "reasonCode", reasonText !== null && "reasonText"]
    : [goodReasonText !== null && "goodReasonText"];
  const fields = misplaced.filter((field) => field !== false);
  if (fields.length > 0) throw new AppError(errors.contacts_input_invalid, { details: { fields } });
  if (good) {
    if (goodReasonText === null) throw new AppError(errors.review_text_required);
    return { decision, reasonCode: null, reasonText: null, goodReasonText };
  }
  if (reasonCode === undefined) throw new AppError(errors.review_reason_required);
  if (reasonCode === "other" && reasonText === null)
    throw new AppError(errors.review_text_required);
  return { decision, reasonCode, reasonText, goodReasonText: null };
}
