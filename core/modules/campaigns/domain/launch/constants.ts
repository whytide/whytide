// The launch checks' values (README.md "Launch checks"; RB-9.4.1, reduced), beside checks.ts, which
// reads them: the checks in the order they are answered, the codes a failing one carries, the
// health states of a sender account that send nothing, and the price the balance must cover.
import { LINKEDIN_SEND_ACTION } from "../send/constants.ts";

/** The checks, in order; the email phase adds `mailbox`, for a sequence with an email step. */
export const LAUNCH_CHECKS = ["linkedin_sender", "sending_disclosure", "credits"] as const;
export type LaunchCheck = (typeof LAUNCH_CHECKS)[number];

/** The code of a failing check: each check's own, read by the screen as campaigns.check.<code>. */
export const LAUNCH_CHECK_CODES = [
  "no_linkedin_sender",
  "linkedin_sender_unhealthy",
  "disclosure_required",
  "insufficient_credits",
] as const;
export type LaunchCheckCode = (typeof LAUNCH_CHECK_CODES)[number];

/** A sender account's health states that refuse every send (linkedin's paused states). */
export const UNHEALTHY_SENDER_STATES = ["restricted", "checkpoint", "disconnected"] as const;

/** The price the balance must cover: the first step's, a connection request, a LinkedIn send. */
export const FIRST_STEP_PRICE = LINKEDIN_SEND_ACTION;
