// inbox's codes (core/packages/platform/README.md "Errors"), each with its key in messages/en.json,
// which messages:check asks of every code.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  /**
   * The message file the event names does not parse with linkedin's schema, or says the other
   * direction: the hold stands, nothing is stored, the file stays for the runbook. 500.
   */
  inbox_file_invalid: { status: 500 },
  /**
   * A label's message is not in the workspace. 404. Not `message_not_found`, the platform's i18n
   * code: a code is registered once (README.md "Decided here").
   */
  inbox_message_not_found: { status: 404 },
  /** A label for a message the account sent: only a reply takes one. 409. */
  message_not_inbound: { status: 409 },
  /** The workspace has no thread of the id. 404. */
  thread_not_found: { status: 404 },
  /**
   * The reply golden set's `week` is not an ISO week its year has, or has not started (beta-p7-030,
   * README.md "The reply golden set"). 400; the command exits 2.
   */
  week_invalid: { status: 400 },
});
