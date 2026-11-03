// The LinkedIn fake's constants (../README.md "The fake", "Events").

/** Pending invitations on one page of listPendingInvites. */
export const PENDING_INVITES_PAGE = 100;
/** The header of the fake's webhooks: `sha256=<hex HMAC-SHA256 of the raw body>`. */
export const SIGNATURE_HEADER = "x-linkedin-fake-signature";
/**
 * The fake's webhook secret under APP_ENV=test, and there only: fixed, so that a webhook a test
 * signs verifies in a separately started api (alpha revisit p7-010). A test value that signs the
 * fake's own webhooks, no account's; anywhere else the fake draws its secret at start.
 */
export const TEST_WEBHOOK_SECRET = "whytide-fake-linkedin-test-webhooks";
/** An account's own member id: this prefix, then the start of its ref's SHA-256, in hex. */
export const SELF_MEMBER_PREFIX = "fake-member-self-";
/** The hex digits of that SHA-256 the id keeps. */
export const SELF_MEMBER_HEX_DIGITS = 32;
/** An acceptance's eventKey: this prefix and a UUID, a new one for each acceptance. */
export const ACCEPTANCE_PREFIX = "fake-acceptance-";
/** A message's ref, sent or emitted, and an emitted one's eventKey: this prefix and a UUID. */
export const MESSAGE_PREFIX = "fake-message-";
