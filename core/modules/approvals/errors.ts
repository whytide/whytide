// approvals' codes (core/packages/platform/README.md "Errors"), each with its key in messages/en.json.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  /** The approve and skip routes: the workspace has no item of the id. 404. */
  approval_item_not_found: {},
  /** Approve or skip of an item decided already, or blocked by a hold or a cancel. 409. */
  approval_item_not_pending: { status: 409 },
  /** Approve of an item whose draft its writer has not ended: it reads as drafting. 409. */
  approval_draft_pending: { status: 409 },
  /** Approve or skip by anyone but the owner of the item's sender account. 403. */
  not_sender_owner: { status: 403 },
  /** A command's input is off its rule, a `withdraw` step included; `details.fields`, no value. 400. */
  approvals_input_invalid: {},
});
