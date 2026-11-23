// The mailbox port's constants (README.md): its words, its bounds, the platform's Message-ID form, the
// words of a report's event, and the bounds and words of the reading (match.ts, reports.ts, mime.ts).
// All not in the sources, but where a line names one.

/** The providers a mailbox connects through, by OAuth only (F11 §4.1). */
export const MAILBOX_PROVIDERS = ["google", "microsoft"] as const;
/** What a grant covers, in the port's words: sending, and reading the platform's threads. */
export const MAILBOX_SCOPES = ["send", "read"] as const;
export type MailboxProvider = (typeof MAILBOX_PROVIDERS)[number];
export type MailboxScope = (typeof MAILBOX_SCOPES)[number];
/** The start of the platform's Message-IDs: `wt-<hash of the step's key>@<the sender's domain>`. */
export const MAILBOX_MESSAGE_ID_PREFIX = "wt-";
/** A raw message, in bytes: 512 KiB, far above a text email's. */
export const MAILBOX_RAW_MAX_BYTES = 512 * 1024;
/** A reply's or a sent message's text, in characters (code points). */
export const MAILBOX_TEXT_MAX_CHARS = 20_000;
/** The messages one listNewMessages reads, and the messages one readThread answers, at most. */
export const MAILBOX_LIST_LIMIT_MAX = 100;
/** The thread refs, and the Message-IDs, one match holds at most. */
export const MAILBOX_MATCH_MAX = 5_000;
/** The seconds after a send within which findSent's `found: false` can mean "not indexed yet". */
export const MAILBOX_FIND_SETTLE_SECONDS = 120;

/** The hash of the step's key in a Message-ID (message-id.ts): SHA-256, in lower-case hex. */
export const MESSAGE_ID_HASH = "sha256";
export const MESSAGE_ID_HASH_HEX_DIGITS = 64;
/** The step's idempotency key (briefs RB-1.2.4), as the LinkedIn port bounds it. */
export const IDEMPOTENCY_KEY_MAX_CHARS = 128;
/** A Message-ID without its angle brackets, a subject, and a To field's value (raw.ts): RFC 5322's line length. */
export const MESSAGE_ID_MAX_CHARS = 998;
export const SUBJECT_MAX_CHARS = 998;
export const TO_MAX_CHARS = 998;
/** An address: RFC 5321's path. */
export const ADDRESS_MAX_CHARS = 254;
/** A provider's message or thread ref: opaque, never parsed. */
export const REF_MAX_CHARS = 512;
/** A cursor, Gmail's history id or Graph's delta links: opaque, stored as it comes. */
export const CURSOR_MAX_CHARS = 8_192;
/** An access or refresh token: opaque; Microsoft's run to a few thousand characters. */
export const TOKEN_MAX_CHARS = 16_384;
/** An authorization code, and a URL: the callback a consent returns to, or a consent page. */
export const CODE_MAX_CHARS = 4_096;
export const URL_MAX_CHARS = 8_192;
/** The caller's state, carried through the consent unchanged: URL-safe characters only. */
export const STATE_FORM = /^[A-Za-z0-9._~-]{1,512}$/;
/** PKCE (RFC 7636): a verifier of 43 to 128 characters, its S256 challenge 43 in base64url. */
export const CODE_VERIFIER_FORM = /^[A-Za-z0-9._~-]{43,128}$/;
export const CODE_CHALLENGE_FORM = /^[A-Za-z0-9_-]{43}$/;
/** A new verifier's random bytes (pkce.ts): 32, RFC 7636's recommendation, 43 characters in base64url. */
export const CODE_VERIFIER_BYTES = 32;

/** A domain of letters, digits and hyphens, ending in a name of letters or a punycode one. */
const DOMAIN = String.raw`(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})`;
/** A plain address, as app-mail's (app-mail/port.ts): no display name, comment, group or quotes. */
const ADDRESS = String.raw`[A-Za-z0-9_'+-]+(?:\.[A-Za-z0-9_'+-]+)*@${DOMAIN}`;
export const PLAIN_ADDRESS = new RegExp(`^${ADDRESS}$`);
/** The platform's Message-ID (message-id.ts): the prefix, the key's hash, at the sender's domain. */
export const PLATFORM_MESSAGE_ID = new RegExp(
  `^${MAILBOX_MESSAGE_ID_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[0-9a-f]{${MESSAGE_ID_HASH_HEX_DIGITS}}@${DOMAIN}$`,
);
/** An address as a message gives it: something at something, no space and no angle bracket. */
export const ANY_ADDRESS = /^[^\s@<>]+@[^\s@<>]+$/;
/** A Message-ID as a provider keeps it, without its angle brackets. */
export const ANY_MESSAGE_ID = /^[^\s<>]+$/;
/**
 * One recipient in a To field (raw.ts): the address alone, or in angle brackets after a display name,
 * quoted or not; never a list, a group or a comment, and no address-like character in the name. In
 * linear time: no two quantifiers in a row take the same character (an unquoted name holds its
 * spaces), and raw.ts reads at most TO_MAX_CHARS with it.
 */
export const ONE_RECIPIENT = new RegExp(
  String.raw`^(?:(?:"(?:[^"\\\r\n<>@]|\\[^\r\n<>@])*"\s*|[^"<>,;:@()[\]\\\r\n]*)<${ADDRESS}>|${ADDRESS})$`,
);

/** The fields a raw message may not hold (raw.ts): a recipient path beside its one To. */
export const REFUSED_FIELDS = ["cc", "bcc", "resent-to", "resent-cc", "resent-bcc"];
/** The one action of a delivery report that is a bounce (RFC 3464): not delayed, delivered or relayed. */
export const FAILED_ACTION = "failed";
/** A bounce's delivery status (RFC 3463): class, subject and detail; class 5 is permanent. */
export const BOUNCE_STATUS_FORM = /^[45]\.\d{1,3}\.\d{1,3}$/;
export const PERMANENT_CLASS = "5.";
/** A feedback report's type (RFC 5965): abuse, fraud, virus, other, not-spam, auth-failure. */
export const FEEDBACK_TYPE_FORM = /^[a-z0-9-]{1,64}$/;

/**
 * What the reading reads at most, before any regular expression: a message's first READ_MAX_CHARS
 * characters (its text part comes before its attachments, a report's status before the returned
 * message), and a header field's first FIELD_READ_MAX_CHARS (a subject of SUBJECT_MAX_CHARS
 * characters fits in quoted-printable encoded words). An address over the bound is not read at all.
 */
export const READ_MAX_CHARS = 1_048_576;
export const FIELD_READ_MAX_CHARS = 16_384;
/** The depth of nested multiparts the reading searches for a message's plain text. */
export const MIME_DEPTH_MAX = 8;
/** The header fields the reading reads, by their names in lower case (RFC 5322, 2045, 2183, 3464, 5965). */
export const FIELD_NAMES = {
  messageId: "message-id",
  inReplyTo: "in-reply-to",
  references: "references",
  from: "from",
  to: "to",
  subject: "subject",
  contentType: "content-type",
  transferEncoding: "content-transfer-encoding",
  disposition: "content-disposition",
  action: "action",
  status: "status",
  feedbackType: "feedback-type",
  xOriginalMessageId: "x-original-message-id",
} as const;
/** A message's head (match.ts headOf), read before its body: what an adapter asks the provider for first. */
export const HEAD_FIELDS: readonly string[] = [
  FIELD_NAMES.messageId,
  FIELD_NAMES.inReplyTo,
  FIELD_NAMES.references,
  FIELD_NAMES.from,
  FIELD_NAMES.subject,
  FIELD_NAMES.contentType,
];
/** The MIME words the reading reads (RFC 2045, 2046, 2183). */
export const MIME = {
  /** The type of a part with no Content-Type, and of the one text the reading gives. */
  plainText: "text/plain",
  multipartPrefix: "multipart/",
  attachment: "attachment",
  base64: "base64",
  quotedPrintable: "quoted-printable",
  boundary: "boundary",
  charset: "charset",
  /** A text without a charset, or in one the runtime's TextDecoder lacks, is read as UTF-8. */
  fallbackCharset: "utf-8",
} as const;
/** Quoted-printable's escape (RFC 2045 §6.7): `=` and two hex digits, either case. */
export const HEX_DIGITS = "0123456789abcdef";
export const HEX_RADIX = 16;
/**
 * An encoded word (RFC 2047), `=?charset?B or Q?text?=`, and the white space between two, which RFC
 * 2047 drops. In linear time: no two quantifiers in a row take the same character.
 */
export const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
export const BETWEEN_ENCODED_WORDS = /(\?=)\s+(?==\?)/g;
/** A line end with a CR inside a decoded text, CRLF or a bare one: the text gives LF. */
export const CR_LINE_END = /\r\n?/g;
/** A report's top-level type (RFC 6522), and the parts reports.ts reads in it. */
export const REPORT_TYPE = "multipart/report";
export const DELIVERY_STATUS_TYPES = ["message/delivery-status", "message/global-delivery-status"];
export const FEEDBACK_REPORT_TYPE = "message/feedback-report";
/** The part that returns the original message, or its headers (RFC 3464, 5965 and 6533). */
export const ORIGINAL_TYPES = [
  "message/rfc822",
  "text/rfc822-headers",
  "message/global",
  "message/global-headers",
];
/** A delivery status's blocks (RFC 3464): the message's, then one per recipient, a blank line between. */
export const STATUS_BLOCK_BREAK = /\r?\n[ \t]*\r?\n/;
/** A recipient's actions (RFC 3464 §2.3.3): FAILED_ACTION is the one a bounce is. */
export const DELIVERY_ACTIONS = ["failed", "delayed", "delivered", "relayed", "expanded"];
/** A delivery status (RFC 3463) at the start of a Status field's value, and its form: class 2, 4 or 5. */
export const STATUS_AT_START = /^\s*(\d\.\d{1,3}\.\d{1,3})(?!\d)/;
export const STATUS_FORM = /^[245]\.\d{1,3}\.\d{1,3}$/;
/** A field value's first word: `failed (bad address)` is `failed`. */
export const FIRST_WORD = /^\s*([A-Za-z0-9-]+)/;
/** A failed delivery without a readable 4.x.x or 5.x.x status: RFC 3463's undefined permanent failure, the safe side. */
export const UNKNOWN_FAILURE = "5.0.0";
/** A feedback report without a readable type: RFC 5965's own `other`. */
export const UNKNOWN_FEEDBACK = "other";
