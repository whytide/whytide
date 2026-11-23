// The campaign's page's words (messages/en.json), each key written out in a literal map, since the
// message check reads string literals only: the steps' names by key, their actions and delays, the
// sequence's rules (`campaigns.sequence_rule.*`), the launch checks and the codes of a failing one
// (`campaigns.launch.check.*`, `campaigns.check.*`), and a preview's failure codes and gates' issues
// (`campaigns.preview.*`). The maps are typed by the domain's lists, so a key, rule, check or code
// added there fails the web's typecheck until its words are here; a code or gate the maps do not
// hold, as messaging may answer, gets a generic word, and a rule they do not hold none.
import { useTranslations } from "next-intl";
import {
  FIRST_MESSAGE_DELAY,
  MAX_STEPS,
  MIN_STEP_DELAY_BUSINESS_DAYS,
  type SequenceAction,
  type SequenceRule,
  STEP_KEYS,
} from "../../domain/campaigns/constants.ts";
import type { LaunchCheck, LaunchCheckCode } from "../../domain/launch/constants.ts";
import type { CampaignResponse, StepResponse } from "../../schemas/campaigns.ts";

type StepKey = (typeof STEP_KEYS)[SequenceAction][number];
/** A gate's issue as messaging writes it: the gate, and what it found. */
export type GateIssue = { readonly gate: string; readonly [field: string]: unknown };

/** The value of `key` in `words`: never a member every object inherits, such as `constructor`. */
const pick = <T>(words: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(words, key) ? words[key] : undefined;
const text = (issue: GateIssue, field: string) => {
  const value = issue[field];
  return typeof value === "string" ? value : "";
};
const count = (issue: GateIssue, field: string) => {
  const value = issue[field];
  return typeof value === "number" ? value : 0;
};

/** The bounds a later step's delay keeps, in business days. */
export type DelayBounds = { readonly min: number; readonly max: number };
/**
 * A campaign's bounds: the least fixed, the most its answer carries, the api's
 * CAMPAIGNS_MAX_STEP_DELAY_BUSINESS_DAYS, never a number of the screen's.
 */
export const delayBounds = ({ limits }: Pick<CampaignResponse, "limits">): DelayBounds => ({
  min: MIN_STEP_DELAY_BUSINESS_DAYS,
  max: limits.maxStepDelayBusinessDays,
});

export function useCampaignWords() {
  const t = useTranslations("campaigns.editor");
  const r = useTranslations("campaigns.sequence_rule");
  const l = useTranslations("campaigns.launch");
  const c = useTranslations("campaigns.check");
  const p = useTranslations("campaigns.preview");
  const steps: Record<StepKey, string> = {
    connect: t("step.connect"),
    message_1: t("step.message_1"),
    follow_up_1: t("step.follow_up_1"),
    follow_up_2: t("step.follow_up_2"),
    email_1: t("step.email_1"),
    email_2: t("step.email_2"),
    email_3: t("step.email_3"),
  };
  const actions: Record<SequenceAction, string> = {
    invite: t("action.invite"),
    message: t("action.message"),
    email: t("action.email"),
  };
  const draw = { min: FIRST_MESSAGE_DELAY.min, max: FIRST_MESSAGE_DELAY.max };
  const rules = (bounds: DelayBounds): Record<SequenceRule, string> => ({
    step_count: r("step_count", { max: MAX_STEPS }),
    step_action: r("step_action"),
    connect_first: r("connect_first"),
    connect_once: r("connect_once"),
    channel_limit: r("channel_limit", {
      messages: STEP_KEYS.message.length,
      emails: STEP_KEYS.email.length,
    }),
    first_message: r("first_message", draw),
    step_delay: r("step_delay", bounds),
    fallback: r("fallback"),
  });
  const checks: Record<LaunchCheck, string> = {
    linkedin_sender: l("check.linkedin_sender"),
    sending_disclosure: l("check.sending_disclosure"),
    credits: l("check.credits"),
  };
  const codes: Record<LaunchCheckCode, string> = {
    no_linkedin_sender: c("no_linkedin_sender"),
    linkedin_sender_unhealthy: c("linkedin_sender_unhealthy"),
    disclosure_required: c("disclosure_required"),
    insufficient_credits: c("insufficient_credits"),
  };
  const failures: Record<string, string> = {
    ai_failed: p("failure.ai_failed"),
    dossier_lead_not_found: p("failure.dossier_lead_not_found"),
    draft_requester_not_member: p("failure.draft_requester_not_member"),
    draft_stuck: p("failure.draft_stuck"),
    profile_not_english: p("failure.profile_not_english"),
    write_failed: p("failure.write_failed"),
  };
  const gates: Record<string, (issue: GateIssue) => string> = {
    facts_used: () => p("gate.facts_used"),
    placeholders: (issue) => p("gate.placeholders", { placeholder: text(issue, "placeholder") }),
    length: (issue) =>
      p("gate.length", {
        length: count(issue, "length"),
        min: count(issue, "min"),
        max: count(issue, "max"),
      }),
    grounding: (issue) => p("gate.grounding", { entity: text(issue, "entity") }),
    red_lines: (issue) => p("gate.red_lines", { phrase: text(issue, "phrase") }),
    colleague_signal: (issue) => p("gate.colleague_signal", { phrase: text(issue, "phrase") }),
    signal_act: (issue) => p("gate.signal_act", { phrase: text(issue, "phrase") }),
  };

  return {
    /** A step's name by its key; one off STEP_KEYS, its action's. */
    step: (stepKey: string, action: SequenceAction) => pick(steps, stepKey) ?? actions[action],
    action: (action: SequenceAction) => actions[action],
    /** When a step falls due, from its delay's anchor. */
    delay: (delay: StepResponse["delay"]) => {
      if (delay.anchor === "enrollment") return t("at_enrollment");
      if (delay.anchor === "accepted") return t("draw", { min: delay.min, max: delay.max });
      if (delay.anchor === "invite_sent") return t("after_invite", { days: delay.value });
      return t("after_previous", { days: delay.value });
    },
    /** The first message's draw after the acceptance, which no one edits. */
    draw: () => t("draw", draw),
    /** A rule's words; the step delay's with the campaign's bounds (delayBounds). */
    rule: (rule: string, bounds: DelayBounds) => pick(rules(bounds), rule),
    check: (check: LaunchCheck) => checks[check],
    code: (code: LaunchCheckCode) => codes[code],
    failure: (code: string) => pick(failures, code) ?? p("failure.other"),
    gate: (issue: GateIssue) => pick(gates, issue.gate)?.(issue) ?? p("gate.other"),
  };
}
