// The words of qualification's keys (messages/en.json) for the screens that show a lead's assessment:
// contacts' lead list (alpha-p6-050) and lead page (alpha-p6-060) read a why bullet's key as data
// (useKeyText of @whytide/ui), and this module, which writes the key, owns its message. One t() call
// per key, written out, so that the message check reads every key; docs/data.md lists the params.
import type { WhyBullet } from "@whytide/contacts";
import type { WhyKey } from "../domain/why/index.ts";
import type { Criterion, Disqualifier, Verdict } from "../schemas/assess-fit.ts";

type Translate = (key: string, values?: Readonly<Record<string, string | number>>) => string;

export function criterionLabels(t: Translate): Record<Criterion, string> {
  return {
    title_function: t("qualification.criterion.title_function"),
    seniority: t("qualification.criterion.seniority"),
    company_size: t("qualification.criterion.company_size"),
    industry: t("qualification.criterion.industry"),
    location: t("qualification.criterion.location"),
    must_haves: t("qualification.criterion.must_haves"),
  };
}

export function verdictLabels(t: Translate): Record<Verdict, string> {
  return {
    met: t("qualification.verdict.met"),
    partially_met: t("qualification.verdict.partially_met"),
    not_met: t("qualification.verdict.not_met"),
    unknown: t("qualification.verdict.unknown"),
  };
}

export function disqualifierLabels(t: Translate): Record<Disqualifier, string> {
  return {
    competitor: t("qualification.disqualifier.competitor"),
    agency_or_consultant: t("qualification.disqualifier.agency_or_consultant"),
    freelancer: t("qualification.disqualifier.freelancer"),
    student_or_intern: t("qualification.disqualifier.student_or_intern"),
    job_seeker: t("qualification.disqualifier.job_seeker"),
    recruiter: t("qualification.disqualifier.recruiter"),
    wrong_business_model: t("qualification.disqualifier.wrong_business_model"),
    own_company: t("qualification.disqualifier.own_company"),
    existing_customer: t("qualification.disqualifier.existing_customer"),
    left_company: t("qualification.disqualifier.left_company"),
    fake_or_inactive_profile: t("qualification.disqualifier.fake_or_inactive_profile"),
  };
}

/** A why bullet's words, for each key buildWhy writes; undefined for any other key. */
export function whyText(t: Translate, { key, params = {} }: WhyBullet): string | undefined {
  switch (key as WhyKey) {
    case "qualification.why.disqualified":
      return t("qualification.why.disqualified", params);
    case "qualification.why.fit":
      return t("qualification.why.fit", params);
    case "qualification.why.gap":
      return t("qualification.why.gap", params);
    case "qualification.why.hard_filtered":
      return t("qualification.why.hard_filtered", params);
    case "qualification.why.must_missed":
      return t("qualification.why.must_missed", params);
    default:
      return undefined;
  }
}
