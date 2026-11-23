// inbox's codes (core/packages/platform/README.md "Errors"), each with its key in messages/en.json,
// which messages:check asks of every code.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  /**
   * The reply classifier's task is not in the agent registry: the host did not load agents/ (README.md
   * "The classifier"). 500; the workflow stores the fallback past its attempts.
   */
  classifier_agent_not_loaded: { status: 500 },
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
  /**
   * A reply draft's brief longer than REPLY_BRIEF_MAX once trimmed; `details.max` (inbox-reply-draft,
   * README.md "The reply draft"). 400.
   */
  reply_brief_too_long: { status: 400 },
  /**
   * A reply on a thread whose channel does not send now: its account not connected, or gone; the
   * person's member id unknown; or a channel other than LinkedIn until the email phase (gamma-p4-060,
   * README.md "Replies from the inbox"). 409. And the begin's refusal once the account or the member
   * id is gone since the press.
   */
  reply_channel_unavailable: { status: 409 },
  /**
   * A reply's text empty once trimmed, or longer than its channel takes; `details.max`, the
   * channel's longest. 400.
   */
  reply_text_invalid: { status: 400 },
  /**
   * The workspace has no thread of the id; for a reply, one the caller does not own, said the same
   * (README.md "Replies from the inbox"). 404.
   */
  thread_not_found: { status: 404 },
  /**
   * The reply golden set's `week` is not an ISO week its year has, or has not started (beta-p7-030,
   * README.md "The reply golden set"). 400; the command exits 2.
   */
  week_invalid: { status: 400 },
});
