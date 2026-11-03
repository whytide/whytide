// The fifteen reasons of Not a fit in words (contacts.review.code.*), in the picker's order: the
// closed list's, Other last. The review panel's picker and the lead list's review column read them.
import { useTranslations } from "next-intl";
import type { ReasonCode } from "../../domain/review/rules.ts";

export function useReasonText(): Record<ReasonCode, string> {
  const t = useTranslations("contacts.review");
  return {
    company_competitor: t("code.company_competitor"),
    company_wrong_industry_or_type: t("code.company_wrong_industry_or_type"),
    company_wrong_size: t("code.company_wrong_size"),
    company_wrong_location: t("code.company_wrong_location"),
    contact_wrong_title_or_function: t("code.contact_wrong_title_or_function"),
    contact_wrong_seniority: t("code.contact_wrong_seniority"),
    contact_known_or_duplicate: t("code.contact_known_or_duplicate"),
    data_incorrect_or_outdated: t("code.data_incorrect_or_outdated"),
    signal_not_relevant: t("code.signal_not_relevant"),
    company_existing_customer: t("code.company_existing_customer"),
    company_in_open_deal: t("code.company_in_open_deal"),
    contact_not_decision_maker: t("code.contact_not_decision_maker"),
    contact_left_company: t("code.contact_left_company"),
    bad_timing: t("code.bad_timing"),
    other: t("code.other"),
  };
}
