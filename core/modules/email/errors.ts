// email's codes (core/packages/platform/README.md "Errors"), each with its key in messages/en.json.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  /** No mailbox with the id in this workspace. 404. */
  email_mailbox_not_found: {},
  /** The caller's mailbox in this workspace is connected already: disconnect it first. 409. */
  mailbox_exists: {},
  /** A callback's state that is unknown, used, expired, another workspace's or another member's. 400. */
  connect_state_invalid: {},
  /** The consent granted less than sending and reading, or the exchange showed no address. 400. */
  mailbox_consent_incomplete: { status: 400 },
  /** The address is connected in another workspace, or its mailbox here is another member's. 409. */
  mailbox_in_use: { status: 409 },
  /** A time zone Intl does not know. 400. */
  mailbox_time_zone_invalid: {},
  /** Only the mailbox's owner disconnects it. 403. */
  not_mailbox_owner: { status: 403 },
  /** The provider's code exchange failed, or the master key changed since the connect: start again. 502. */
  mailbox_connect_failed: { status: 502 },
});
