// The mailbox fake's constants (../README.md "The fake"): its addresses, all synthetic, its lives
// and the prefixes of what it hands out.

/** The mailbox a consent connects when consentNext gives no address, or a null one. */
export const FAKE_ADDRESS = "member@fake-mailbox.example";
/** Who a played reply, a sent message and an unsubscribe mail are from or to, when a helper is given no one. */
export const FAKE_LEAD = "lead@fake-lead.example";
/** Who a playPersonal message is from when given no one. */
export const FAKE_FRIEND = "friend@fake-personal.example";
/** Who the played reports are from. */
export const FAKE_MAILER = "mailer-daemon@fake-mailbox.example";
/** The domain of the Message-IDs the fake's mail program gives: never of the platform's form. */
export const FAKE_MESSAGE_DOMAIN = "fake-mail-program.example";
/** An access token's life, in seconds, as Google's and Microsoft's. */
export const ACCESS_TTL_SECONDS = 3_600;
/** The seconds a rate limit asks to wait when failNext gives none. */
export const RETRY_AFTER_SEC = 60;
/** The start of each thing the fake hands out, a UUID or a number after it. */
export const PREFIX = {
  code: "fake-code-",
  refresh: "fake-refresh-",
  access: "fake-access-",
  message: "fake-message-",
  thread: "fake-thread-",
  cursor: "fake-cursor:",
} as const;
/** The boundary of a played report's parts. */
export const REPORT_BOUNDARY = "fake-report-boundary";
/** A played bounce's status, and a played complaint's feedback type, when the helper is given none. */
export const BOUNCE_STATUS = "5.1.1";
export const FEEDBACK_TYPE = "abuse";
/** The words of a played message when its helper is given none: synthetic, naming nobody. */
export const PLAYED = {
  replyText: "Thanks, tell me more.",
  sentSubject: "A note typed in the mail program",
  sentText: "Typed in the mail program.",
  personalSubject: "A personal note",
  personalText: "Nothing for the platform.",
  bounceSubject: "Delivery Status Notification (Failure)",
  complaintSubject: "An abuse report",
  reportText: "A report the fake played.",
} as const;
