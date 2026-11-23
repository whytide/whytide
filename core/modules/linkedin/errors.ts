// linkedin's codes (core/packages/platform/README.md "Errors"), each with its key in messages/en.json.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  /**
   * A connect without `acknowledged: true` and the current DISCLOSURE_VERSION: the risk disclosure
   * comes first. 400. And reserveSend's refusal of an account whose owner has not accepted the
   * sending disclosure, with the personal-account confirmation; retryAt null.
   */
  disclosure_required: { status: 400 },
  /** No sender account with the id in this workspace. 404. */
  sender_account_not_found: {},
  /** Times not `HH:MM` with start before end, days not distinct 1 to 7, or a zone Intl does not know; `details.fields`. 400. */
  working_hours_invalid: {},
  /** The user's account in this workspace is connected already: disconnect it first. 409. */
  sender_account_exists: {},
  /** A daily read cap that is not a whole number from 1 to LINKEDIN_DAILY_READ_CAP_MAX; `details.fields`, `details.max`. 400. */
  read_cap_invalid: {},
  /** reserveReads' refusal: the day's reads, reserved and made, pass the smaller of the day's read allowance and the cap; with the next quota day's start. 429. */
  read_cap_reached: { status: 429 },
  /** A reservation's refusal: the day's 200 actions, reserved and made, leave no room; with the next quota day's start. 429. */
  daily_actions_cap_reached: { status: 429 },
  /** A reservation's refusal: the account's working hours are closed now, and for a send on Saturday and Sunday; with the next window's start. 409. */
  outside_working_hours: { status: 409 },
  /** A settle of a reservation not in this workspace, of the other kind, or settled the other way. 409. */
  reservation_not_open: { status: 409 },
  /** An input of the quota or the action log off its schema, an objectRef that is no post URL, person id or step execution among them; `details.fields`. 400. */
  read_input_invalid: { status: 400 },
  /**
   * The webhook's pairing: the LinkedIn account a user connected is another user's account in this
   * workspace already; the pending account ends `disconnected`, its link cleared. 409. And a status
   * check's outcome: its member id is another connected row's, in any workspace; the account ends
   * `disconnected`, its reference cleared, and the activity answers it as a result, never retried.
   */
  sender_account_in_use: { status: 409 },
  /** reserveSend's refusal: the account's LINKEDIN_INVITE_NOTES_PER_MONTH notes in 30 days are used; with when the oldest leaves them. 429. */
  invite_note_budget: { status: 429 },
  /** reserveSend's refusal: the day's connection requests, reserved and made, reach its limit; with the next quota day's start. 429. */
  invite_cap_reached: { status: 429 },
  /** reserveSend's refusal: the day's messages reach its limit; with the next quota day's start. 429. */
  message_cap_reached: { status: 429 },
  /** reserveSend's refusal: the day's withdrawals reach their hard maximum; with the next quota day's start. 429. */
  withdrawal_cap_reached: { status: 429 },
  /** reserveSend's refusal: the last seven quota days' connection requests reach the weekly cap; with the first day it allows one. 429. */
  weekly_invite_cap_reached: { status: 429 },
  /** reserveSend's refusal: sending is closed on the instance (no platform row, or `sending_open` false) until the operator opens it; retryAt null. 409. */
  sending_closed: { status: 409 },
  /** A reservation's refusal, reads included: the operator stopped every LinkedIn action on the instance; retryAt null. 409. */
  platform_stopped: { status: 409 },
  /** A reservation's refusal, reads included: the workspace's "Stop everything" is on; retryAt null. 409. */
  workspace_stopped: { status: 409 },
  /** A reservation's refusal, reads included: the account is paused (its kill switch); retryAt null. 409. */
  account_stopped: { status: 409 },
  /** A reservation's refusal, reads included: the account's health is restricted, checkpoint or disconnected (domain/health/); retryAt null. 409. */
  account_paused: { status: 409 },
  /** reserveSend's refusal of an invite while the platform's invites are paused (the fleet breaker) or the account is at_risk; retryAt null. 409. */
  invites_paused: { status: 409 },
  /** Only the account's owner resumes it. 403. */
  not_account_owner: { status: 403 },
  /** The operator's stop or pause, which only the operator lifts. 409. */
  stopped_by_operator: { status: 409 },
  /**
   * A send activity's attempt with less than SEND_CALL_MIN_LEFT_MS of its time left before the port
   * call: no call, the slot kept; retried, and the next attempt checks first. Worker only.
   */
  send_attempt_late: {},
  /** A connect or an acceptance without `personalAccount: true`: the account must be the owner's own personal one. 400. */
  personal_account_required: { status: 400 },
  /** An acceptance of a disclosure version other than DISCLOSURE_VERSION, the screen's. 400. */
  disclosure_version_invalid: { status: 400 },
  /** reserveSend's refusal: the account's LinkedIn member id is not known yet (the status refresh stores it); retryAt null. 409. */
  member_id_unknown: { status: 409 },
  /** The receiver's, for an event it keeps while LINKEDIN_HASH_KEY is empty: the provider delivers it again later. 500. */
  linkedin_hash_key_missing: { status: 500 },
  /**
   * reserveSend's refusal of an invite while the account's pending invitations were never counted, or
   * counted more than 48 hours ago; retryAt the hour after today's check_after, or after now once it
   * has passed, while today's check is still to come, else the next quota day's start. 409.
   */
  pending_invites_unknown: { status: 409 },
  /** reserveSend's refusal of an invite while more than 400 invitations are pending, the invites in flight counted; retryAt the next quota day's start. 429. */
  pending_invites_over_limit: { status: 429 },
  /** The owner's resume of an account whose health is not restricted or checkpoint: no cool-down to end. 409. */
  account_not_paused: { status: 409 },
  /** The owner's resume before the cool-down's end; `details.pausedUntil`, ISO. 409. */
  cooldown_active: { status: 409 },
  /** The owner's resume of a checkpoint with no reconnect since: connected_at not after health_changed_at. 409. */
  reconnect_required: { status: 409 },
  /** The owner's resume with no status checked after the cool-down's end, or one more than 10 minutes old: Check status first. 409. */
  status_check_required: { status: 409 },
  /** readCompany outside the worker, where no account's reference can be opened (gamma-en-060). 500. */
  company_read_unavailable: { status: 500 },
  /** readContactEmails outside the worker, where no account's reference can be opened (gamma-en-087). 500. */
  contact_read_unavailable: { status: 500 },
});
