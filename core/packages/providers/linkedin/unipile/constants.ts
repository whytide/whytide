// The Unipile adapter's constants. The post links listPostEngagers reads are the six forms signals
// accepts: POST_PATHS of core/modules/signals/sources/post_engagers/post-url.ts, copied here with the
// kind and the id captured, since providers never imports a module. A change to one is a change to
// the other. Then the client's bounds and the vendor's error types it maps (README.md "Errors"),
// read on 2026-10-29 in Unipile's API reference, the send calls' pages, and the webhooks' header,
// pairing names, statuses and events (README.md "Webhooks", "Pairing"), read there the same day.
import type { LinkedinDisconnectReason } from "../port.ts";

/** The kind of post a link names. */
const KIND = "(activity|share|ugcPost)";
/** A colon of the URN, plain or percent-encoded. */
const COLON = "(?::|%3[Aa])";

/**
 * The path of a post's link, its kind and id captured: /posts/<slug>-<kind>-<id>-<code>, where the
 * greedy slug leaves the link its last -<kind>-<id>-, so that a slug word such as market-share-40
 * never counts; or /feed/update/urn:li:<kind>:<id>.
 */
export const POST_PATHS: readonly RegExp[] = [
  new RegExp(`^/posts/[\\w%.~-]+-${KIND}-(\\d{1,30})-[\\w-]+/?$`),
  new RegExp(`^/feed/update/urn${COLON}li${COLON}${KIND}${COLON}(\\d{1,30})/?$`),
];

/**
 * The kind Unipile is asked for by its number, as before share and ugcPost links were read, so that
 * a run's cursor, which keeps that number as `post`, still resumes. Any other kind is asked for as
 * urn:li:<kind>:<id>: Unipile answers 404 for a share's number (checked on 2026-10-28).
 */
export const ACTIVITY = "activity";

/** A redirect's statuses: the client never follows one, so that the key never leaves for its host. */
export const REDIRECT_STATUS = { min: 300, max: 399 } as const;

/**
 * A network error's code as Node's fetch gives it in `error.cause.code` (`ECONNRESET`,
 * `UND_ERR_SOCKET`): kept in a provider error only in this short upper-case form, never the message.
 */
export const NETWORK_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** How long one request may take, its answer read to the end included. */
export const TIMEOUT_MS = 30_000;

/** The longest answer the client reads, 1 MiB; a longer one is refused unparsed (answer_too_large). */
export const MAX_ANSWER_BYTES = 1024 * 1024;

/** The seconds a 429 asks to wait when its Retry-After gives none. */
export const RETRY_AFTER_SEC = 60;

/** The shortest UNIPILE_WEBHOOK_SECRET and UNIPILE_CURSOR_SECRET create() accepts. */
export const SECRET_MIN_CHARS = 32;

/** A vendor's error type as the client keeps it, `errors/<reason>`, and nothing else of the body. */
export const ERROR_TYPE = /^errors\/[a-z0-9_]{1,64}$/;

/** The status of LinkedIn's own limits and refusals at Unipile. */
export const UNPROCESSABLE = 422;

/**
 * The error types of an account that is not connected, whatever the status, each with
 * linkedin_account_disconnected's `details.reason`.
 */
export const DISCONNECTED_TYPES: ReadonlyMap<string, LinkedinDisconnectReason> = new Map([
  ["errors/account_restricted", "restricted"],
  ["errors/checkpoint_error", "checkpoint"],
  ["errors/expired_credentials", "credentials_required"],
  ["errors/disconnected_account", "disconnected"],
]);

/**
 * A 422's types of LinkedIn's own limits, linkedin_limit_reached: cannot_resend_yet is the weekly
 * invitation limit (Unipile's provider limits); the others are mapped by their names.
 */
export const LIMIT_TYPES: ReadonlySet<string> = new Set([
  "errors/cannot_resend_yet",
  "errors/cannot_resend_within_24hrs",
  "errors/limit_exceeded",
  "errors/connection_limit_reached",
]);

/** A 422's types of a permanent refusal of a send, linkedin_send_refused, each with its reason. */
export const REFUSED_TYPES: ReadonlyMap<string, string> = new Map([
  ["errors/already_invited_recently", "already_invited"],
  ["errors/already_connected", "already_connected"],
  ["errors/no_connection_with_recipient", "not_connected"],
  ["errors/cannot_invite_attendee", "recipient_unavailable"],
  ["errors/invalid_recipient", "recipient_unavailable"],
  ["errors/blocked_recipient", "recipient_unavailable"],
  ["errors/user_unreachable", "recipient_unavailable"],
]);

/** Pending invitations asked for per page: Unipile's most, as many as the fake's page. */
export const INVITES_PAGE = 100;

/** A relation's network distance, and an invitation of the account's still pending, at Unipile. */
export const RELATION = "FIRST_DEGREE";
export const PENDING_INVITATION = { type: "SENT", status: "PENDING" } as const;

/** The member's chats with the account read at most, and the messages asked for per page. */
export const MEMBER_CHATS = 10;
export const MESSAGES_PAGE = 100;

/** Vendor pages one listRecentMessages reads at most, its chats together: a looping cursor stops. */
export const MAX_MESSAGE_PAGES = 10;

/** The header the three webhook sources are registered with, holding UNIPILE_WEBHOOK_SECRET. */
export const SECRET_HEADER = "unipile-auth";

/** A hosted link's providerRef: this prefix and a UUID (README.md "Pairing"). */
export const PROVIDER_REF_PREFIX = "whytide-";

/** Between a link's providerRef and its pairing token, in the `name` Unipile echoes. */
export const PAIRING_SEPARATOR = ".";

/** A pairing token's characters: an HMAC-SHA-256, 32 bytes, in base64url without padding. */
const PAIRING_TOKEN_CHARS = 43;

/**
 * Every pairing name in a notify's raw text, `<providerRef>.<token>`, found before the body is parsed
 * (global: read with String.prototype.match only, which starts each search afresh).
 */
export const PAIRING_NAMES = new RegExp(
  `${PROVIDER_REF_PREFIX}[0-9a-f-]{36}\\${PAIRING_SEPARATOR}[\\w-]{${PAIRING_TOKEN_CHARS}}`,
  "g",
);

/** The statuses of the hosted-auth notify: a link's new account, or one reconnected. */
export const NOTIFY_STATUSES = ["CREATION_SUCCESS", "RECONNECTED"] as const;

/**
 * The account statuses read as connected. CREDENTIALS asks for the credentials; every other status,
 * an unknown one included, reads as disconnected, never `ignored` (docs/07 §5.7, item 3).
 */
export const CONNECTED_STATUSES: ReadonlySet<unknown> = new Set([
  "OK",
  "RECONNECTED",
  "CREATION_SUCCESS",
  "SYNC_SUCCESS",
]);
export const CREDENTIALS_STATUS = "CREDENTIALS";

/** The events mapped of the messaging and users sources; any other event of theirs is `ignored`. */
export const MESSAGE_EVENT = "message_received";
export const RELATION_EVENT = "new_relation";

/** Between the parts of an acceptance's eventKey, `new_relation:<account_id>:<user_provider_id>`. */
export const EVENT_KEY_SEPARATOR = ":";
