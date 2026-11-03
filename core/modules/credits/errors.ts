// credits' codes (core/packages/platform/README.md "Errors", "Credits"), each with its key in
// messages/en.json. The platform throws credits_not_bound by its name, before this module binds.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  /** reserve: fewer credits available to the organization than the reservation needs; no row. 402. */
  insufficient_credits: { status: 402 },
  /** commit, release: no such usage in the workspace, or it is settled or its lease ran out. 409. */
  usage_not_open: { status: 409 },
  /** A call to the credits client before this module bound it at the host's start. 500. */
  credits_not_bound: { status: 500 },
  /** An input off the client's rules, or an action without a price; `details.fields`. 400. */
  credits_input_invalid: {},
});
