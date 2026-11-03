// identity's codes (core/packages/platform/README.md "Errors"), each with its key in messages/en.json.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  /** The first sign-in of an email with neither an invite nor a user: nothing is created. 403. */
  invite_required: {},
  /** createInvite: the workspace has an invite for the email already, accepted or not. 409. */
  invite_exists: {},
  /** A command's input off its rule (domain/rules.ts); `details.fields` names the fields. 400. */
  identity_input_invalid: {},
});
