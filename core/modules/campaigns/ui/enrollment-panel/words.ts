// The enrollment panel's words (messages/en.json, `campaigns.enrollment.*` and `campaigns.reason.*`),
// each key written out in a literal map, since the message check reads string literals only: the
// statuses, the steps' names, and every code of STEP_REASON_CODES and EXIT_DETAILS
// (domain/steps/constants.ts) and every exit reason. The maps are typed by those lists, so a code
// added there fails the web's typecheck until its key is here; a code the map does not hold, as a
// newer api may answer, shows campaigns.reason.unknown.
import { useTranslations } from "next-intl";
import type { EnrollmentStatus, ExitReason, StepStatus } from "../../domain/constants.ts";
import type { ExitDetail, StepReasonCode } from "../../domain/steps/constants.ts";
import type { StepKey } from "../../domain/template/constants.ts";
import type { WITHDRAW_STEP_KEY } from "../../domain/withdraw/constants.ts";

/** The value of `key` in `words`: never a member every object inherits, such as `constructor`. */
const pick = <T>(words: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(words, key) ? words[key] : undefined;

export function useEnrollmentWords() {
  const t = useTranslations("campaigns.enrollment");
  const r = useTranslations("campaigns.reason");
  /** An enrollment's status; `refused` for one that exited as it was made, never started. */
  const status: Record<EnrollmentStatus | "refused", string> = {
    active: t("status.active"),
    replied: t("status.replied"),
    completed: t("status.completed"),
    exited: t("status.exited"),
    paused: t("status.paused"),
    refused: t("status.refused"),
  };
  const stepStatus: Record<StepStatus, string> = {
    planned: t("step_status.planned"),
    awaiting_approval: t("step_status.awaiting_approval"),
    scheduled: t("step_status.scheduled"),
    executing: t("step_status.executing"),
    succeeded: t("step_status.succeeded"),
    failed: t("step_status.failed"),
    skipped: t("step_status.skipped"),
    held: t("step_status.held"),
    cancelled: t("step_status.cancelled"),
  };
  const names: Record<StepKey | typeof WITHDRAW_STEP_KEY, string> = {
    connect: t("step.connect"),
    message_1: t("step.message_1"),
    follow_up_1: t("step.follow_up_1"),
    follow_up_2: t("step.follow_up_2"),
    withdraw: t("step.withdraw"),
  };
  const reasons: Record<StepReasonCode | ExitDetail | ExitReason, string> = {
    never_contact_person: r("never_contact_person"),
    never_contact_company: r("never_contact_company"),
    opted_out: r("opted_out"),
    person_not_found: r("person_not_found"),
    recently_contacted: r("recently_contacted"),
    replied: r("replied"),
    enrollment_ended: r("enrollment_ended"),
    touched_today: r("touched_today"),
    skipped_by_owner: r("skipped_by_owner"),
    not_approved: r("not_approved"),
    content_changed: r("content_changed"),
    insufficient_credits: r("insufficient_credits"),
    member_ref_unknown: r("member_ref_unknown"),
    profile_unreadable: r("profile_unreadable"),
    already_connected: r("already_connected"),
    not_interested: r("not_interested"),
    sending_closed: r("sending_closed"),
    platform_stopped: r("platform_stopped"),
    workspace_stopped: r("workspace_stopped"),
    account_stopped: r("account_stopped"),
    account_paused: r("account_paused"),
    linkedin_account_disconnected: r("linkedin_account_disconnected"),
    rate_limited: r("rate_limited"),
    outside_working_hours: r("outside_working_hours"),
    invites_paused: r("invites_paused"),
    disclosure_required: r("disclosure_required"),
    member_id_unknown: r("member_id_unknown"),
    invite_note_budget: r("invite_note_budget"),
    invite_cap_reached: r("invite_cap_reached"),
    message_cap_reached: r("message_cap_reached"),
    withdrawal_cap_reached: r("withdrawal_cap_reached"),
    weekly_invite_cap_reached: r("weekly_invite_cap_reached"),
    daily_actions_cap_reached: r("daily_actions_cap_reached"),
    read_cap_reached: r("read_cap_reached"),
    pending_invites_over_limit: r("pending_invites_over_limit"),
    pending_invites_unknown: r("pending_invites_unknown"),
    reservation_not_open: r("reservation_not_open"),
    suppressed: r("suppressed"),
    removed: r("removed"),
    no_sender: r("no_sender"),
    not_accepted: r("not_accepted"),
    send_refused: r("send_refused"),
    // A withdrawal's (beta-p4-060); not_accepted above.
    linkedin_not_found: r("linkedin_not_found"),
    linkedin_send_refused: r("linkedin_send_refused"),
    invite_accepted: r("invite_accepted"),
    // beta-p4-040: the port's codes (linkedin_not_found and linkedin_send_refused above), a
    // replaced account, a step waiting on one in flight.
    linkedin_rate_limited: r("linkedin_rate_limited"),
    linkedin_provider_error: r("linkedin_provider_error"),
    linkedin_output_invalid: r("linkedin_output_invalid"),
    linkedin_error_unmapped: r("linkedin_error_unmapped"),
    linkedin_limit_reached: r("linkedin_limit_reached"),
    linkedin_input_invalid: r("linkedin_input_invalid"),
    account_replaced: r("account_replaced"),
    send_in_flight: r("send_in_flight"),
    // gamma-p3-060: a step waiting while its enrollment, or its campaign, is paused.
    enrollment_paused: r("enrollment_paused"),
    campaign_not_active: r("campaign_not_active"),
    // gamma-p6-040: the sender's owner removed, an email's mailbox another member's.
    owner_removed: r("owner_removed"),
    sender_mismatch: r("sender_mismatch"),
    // gamma-rf-050: a LinkedIn step of a person without a LinkedIn profile.
    no_linkedin_profile: r("no_linkedin_profile"),
  };
  return {
    status,
    stepStatus,
    /** A step's name by its key; a step the template does not hold has the shared one. */
    name: (stepKey: string) => pick(names, stepKey) ?? t("step.other"),
    /** A code in words; campaigns.reason.unknown for one the map does not hold. */
    reason: (code: string) => pick(reasons, code) ?? r("unknown"),
  };
}
