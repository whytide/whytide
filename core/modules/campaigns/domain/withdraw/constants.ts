// The withdrawal's values (README.md "Withdrawals"; docs/flows.md "The withdrawal"), beside the code
// that reads them: open.ts, which opens a withdrawal for each connection request left unaccepted too
// long, accepted.ts, and settle.ts, which ends the enrollment once it went out or the invitation
// was gone.
import { TEMPLATE_STEPS } from "../template/constants.ts";

/** Days a connection request may stay unaccepted before it is withdrawn: 21, fixed (RB-11.2.5). */
export const INVITE_WITHDRAW_AFTER_DAYS = 21;
export const MS_PER_DAY = 86_400_000;

/** The template's connection request, whose invitation a withdrawal takes back. */
export const INVITE_STEP = TEMPLATE_STEPS[0] satisfies { readonly action: "invite" };
/** The withdrawal's step, beside the template's four: one per enrollment at most (the unique key). */
export const WITHDRAW_STEP_KEY = "withdraw";
/** Its position: the connection request's, whose invitation it takes back. */
export const WITHDRAW_POSITION = 1;
/** What follows the connection request's key to make the withdrawal's own (beta-p1-030). */
export const WITHDRAW_KEY_SUFFIX = ":withdraw";
/** A withdrawal's statuses once it took the invitation back: sent, or the invitation gone. */
export const WITHDRAWN_STATUSES = ["succeeded", "failed"] as const;

/**
 * linkedin's answers after a withdrawal's call that say the invitation is already gone (declined,
 * expired or withdrawn by hand): each its step's error_code (linkedin's error map, SEND_REFUSED).
 */
export const INVITATION_GONE_CODES = ["linkedin_not_found", "linkedin_send_refused"] as const;
/**
 * A withdrawal's own codes: its step cancelled at the gate once the connection request was accepted
 * (invite_accepted), and the pending steps its end cancels (not_accepted, the enrollment's exit
 * reason).
 */
export const WITHDRAWAL_CODES = [
  ...INVITATION_GONE_CODES,
  "invite_accepted",
  "not_accepted",
] as const;
