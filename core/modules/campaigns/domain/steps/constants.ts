// The codes a step's skip_reason and error_code, and an enrollment's exit_detail, may hold (README.md
// "Reason codes"), beside the writers that check them (codes.ts) and the panel that maps each to a
// message key (beta-p2-060). Each later task adds its own codes here.
import { WITHDRAWAL_CODES } from "../withdraw/constants.ts";

/**
 * linkedin's refusals of a send before its call, each a step's error_code while it waits to be
 * placed again (beta-p4-020): reserveSend's, the send activity's re-read of them, its reservation
 * no longer open (a pause releases it), and reserveReads' for the chat read before a message; with
 * account_paused and invites_paused from the account's health, and an invite's two while the count
 * of the account's pending invitations is unknown or over its limit (beta-p4-070), each with a time.
 */
export const SEND_REFUSAL_CODES = [
  "sending_closed",
  "platform_stopped",
  "workspace_stopped",
  "account_stopped",
  "account_paused",
  "linkedin_account_disconnected",
  "rate_limited",
  "outside_working_hours",
  "invites_paused",
  "disclosure_required",
  "member_id_unknown",
  "invite_note_budget",
  "invite_cap_reached",
  "message_cap_reached",
  "withdrawal_cap_reached",
  "weekly_invite_cap_reached",
  "daily_actions_cap_reached",
  "read_cap_reached",
  "pending_invites_over_limit",
  "pending_invites_unknown",
  "reservation_not_open",
] as const;

/**
 * beta-p4-040's codes: the LinkedIn port's that a send's answer carries (linkedin's SEND_ERROR_MAP;
 * linkedin_account_disconnected is a refusal above, linkedin_send_refused and linkedin_not_found a
 * withdrawal's, WITHDRAWAL_CODES), each a waiting step's error_code, one left `executing`, or a
 * failed step's and its cancelled steps'; a replaced sender account's cancel; and a person's step
 * waiting while another of their steps is in flight.
 */
export const RECOVERY_CODES = [
  "linkedin_rate_limited",
  "linkedin_provider_error",
  "linkedin_output_invalid",
  "linkedin_error_unmapped",
  "linkedin_limit_reached",
  "linkedin_input_invalid",
  "account_replaced",
  "send_in_flight",
] as const;

/**
 * What a step's skip_reason and error_code may hold: contacts' suppression reasons a step can stop
 * on, a reply, an enrollment that ended, and a person already touched on the day; the owner's skip
 * in "Up next" (the step, and the steps a skipped connection request cancels); the gate's two
 * approval blocks, an item not approved and an approved text changed since (beta-p3-050); and the
 * sender's waits (beta-p4-020): no credits left, no member id known, and linkedin's refusals.
 */
export const STEP_REASON_CODES = [
  "never_contact_person",
  "never_contact_company",
  "opted_out",
  "person_not_found",
  "replied",
  "enrollment_ended",
  "touched_today",
  "skipped_by_owner",
  "not_approved",
  "content_changed",
  "insufficient_credits",
  "member_ref_unknown",
  // The profile read before a connection request found no profile: the step `failed` (beta-p4-030).
  "profile_unreadable",
  ...SEND_REFUSAL_CODES,
  // A withdrawal's (beta-p4-060): ../withdraw/constants.ts.
  ...WITHDRAWAL_CODES,
  ...RECOVERY_CODES,
] as const;

/**
 * What an enrollment's exit_detail may hold: the suppression reason behind `suppressed`, among them
 * recently_contacted, which only a new enrollment meets.
 */
export const EXIT_DETAILS = [
  "never_contact_person",
  "never_contact_company",
  "opted_out",
  "person_not_found",
  "recently_contacted",
  // beta-p4-040: a replaced account (no_sender), a request off the port's schema (send_refused).
  "account_replaced",
  "linkedin_input_invalid",
] as const;

/**
 * The actions the queue opens an item in "Up next" for, as approvals' items hold them: a connection
 * request and a message.
 */
export const APPROVED_ACTIONS = ["invite", "message"] as const;
/**
 * The actions that need no approval, by name: a withdrawal sends nothing to the person and has no
 * item. Every other action, one added later included, needs its approved item at the gate.
 */
export const APPROVAL_EXEMPT_ACTIONS = ["withdraw"] as const;

export type StepReasonCode = (typeof STEP_REASON_CODES)[number];
export type SendRefusalCode = (typeof SEND_REFUSAL_CODES)[number];
export type ExitDetail = (typeof EXIT_DETAILS)[number];
export type ApprovedAction = (typeof APPROVED_ACTIONS)[number];
