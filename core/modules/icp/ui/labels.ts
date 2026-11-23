// The labels of the ICP's closed lists (domain/lists.ts), its criteria and its codes, for its screen
// (alpha-p4-050): one t() call per value, written out, so that the message check reads every key of
// icp.seniority.*, icp.size.*, icp.criterion.* and icp.errors.*.
import type { CriterionKey, DRAFT_RUN_CODES, Seniority, SizeRange } from "../domain/lists.ts";
import type { draftErrors, errors } from "../errors.ts";

type Translate = (key: string) => string;

export function seniorityLabels(t: Translate): Record<Seniority, string> {
  return {
    owner_founder: t("icp.seniority.owner_founder"),
    c_level: t("icp.seniority.c_level"),
    vp: t("icp.seniority.vp"),
    head: t("icp.seniority.head"),
    director: t("icp.seniority.director"),
    manager: t("icp.seniority.manager"),
    senior_ic: t("icp.seniority.senior_ic"),
    ic: t("icp.seniority.ic"),
  };
}

export function sizeRangeLabels(t: Translate): Record<SizeRange, string> {
  return {
    "1-10": t("icp.size.from_1_to_10"),
    "11-50": t("icp.size.from_11_to_50"),
    "51-200": t("icp.size.from_51_to_200"),
    "201-500": t("icp.size.from_201_to_500"),
    "501-1000": t("icp.size.from_501_to_1000"),
    "1001-5000": t("icp.size.from_1001_to_5000"),
    "5001+": t("icp.size.over_5000"),
  };
}

export function criterionLabels(t: Translate): Record<CriterionKey, string> {
  return {
    title_function: t("icp.criterion.title_function"),
    seniority: t("icp.criterion.seniority"),
    company_size: t("icp.criterion.company_size"),
    industry: t("icp.criterion.industry"),
    location: t("icp.criterion.location"),
    must_haves: t("icp.criterion.must_haves"),
  };
}

/** The words of each code of errors.ts, shown next to the field the code is about. */
export function errorLabels(t: Translate): Record<keyof typeof errors, string> {
  return {
    icp_weights_must_sum_100: t("icp.errors.icp_weights_must_sum_100"),
    icp_unknown_seniority: t("icp.errors.icp_unknown_seniority"),
    icp_unknown_size_range: t("icp.errors.icp_unknown_size_range"),
    icp_unknown_country: t("icp.errors.icp_unknown_country"),
    icp_not_found: t("icp.errors.icp_not_found"),
    icp_audience_limit: t("icp.errors.icp_audience_limit"),
  };
}

/**
 * The draft's codes the screen's draft card shows in words (README "The draft"): its routes' and a
 * failed run's; icp_draft_agent_not_loaded is the worker's, which no route answers.
 */
export type DraftCode =
  | Exclude<keyof typeof draftErrors, "icp_draft_agent_not_loaded">
  | (typeof DRAFT_RUN_CODES)[keyof typeof DRAFT_RUN_CODES];

export function draftErrorLabels(t: Translate): Record<DraftCode, string> {
  return {
    icp_draft_brief_too_long: t("icp.errors.icp_draft_brief_too_long"),
    icp_draft_no_source: t("icp.errors.icp_draft_no_source"),
    icp_draft_none: t("icp.errors.icp_draft_none"),
    icp_not_empty: t("icp.errors.icp_not_empty"),
    icp_draft_invalid: t("icp.errors.icp_draft_invalid"),
    ai_failed: t("icp.errors.ai_failed"),
    draft_failed: t("icp.errors.draft_failed"),
  };
}
