// linkedin's codes (core/packages/platform/README.md "Errors"), each with its key in messages/en.json.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  /** A connect without `acknowledged: true`: the risk disclosure comes first. 400. */
  disclosure_required: { status: 400 },
  /** No sender account with the id in this workspace. 404. */
  sender_account_not_found: {},
  /** Times not `HH:MM` with start before end, days not distinct 1 to 7, or a zone Intl does not know; `details.fields`. 400. */
  working_hours_invalid: {},
  /** The user's account in this workspace is connected already: disconnect it first. 409. */
  sender_account_exists: {},
  /** A daily read cap that is not a whole number from 1 to LINKEDIN_DAILY_READ_CAP_MAX; `details.fields`, `details.max`. 400. */
  read_cap_invalid: {},
  /** reserveReads' refusal: the day's reads, reserved and made, leave no room; with the next quota day's start. 429. */
  read_cap_reached: { status: 429 },
  /** reserveReads' refusal: the account's working hours are closed now; with the next window's start. 409. */
  outside_working_hours: { status: 409 },
  /** commitReads or releaseReads on a reservation not in this workspace, or settled the other way. 409. */
  reservation_not_open: { status: 409 },
  /** An input of the read quota or the action log off its schema, an objectRef that is no post URL or person id among them; `details.fields`. 400. */
  read_input_invalid: { status: 400 },
});
