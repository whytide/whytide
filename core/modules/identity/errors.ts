// identity's codes (core/packages/platform/README.md "Errors"), each with its key in messages/en.json.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  /** The first sign-in of an email with neither an invite nor a user: nothing is created. 403. */
  invite_required: {},
  /** createInvite: the workspace has an open invite for the email already. 409. */
  invite_exists: {},
  /** A command's input off its rule (domain/rules.ts); `details.fields` names the fields. 400. */
  identity_input_invalid: {},
  /**
   * No invite with the id in the workspace, or, for an accept, none open of the caller's own email:
   * it never says whose invite it is. 404.
   */
  invite_not_found: { status: 404 },
  /** revokeInvite: the invite made its membership already. 409. */
  invite_accepted: { status: 409 },
  /** createInvite: the email's user is an active member of the workspace. 409. */
  already_member: { status: 409 },
});
