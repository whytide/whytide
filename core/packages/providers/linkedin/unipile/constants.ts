// The Unipile adapter's constants. The post links listPostEngagers reads are the port's POST_PATHS
// (../constants.ts). Then the client's bounds and the vendor's error types it maps (README.md
// "Errors"), read on 2026-10-29 in Unipile's API reference, the send calls' pages, and the webhooks'
// header, pairing names, statuses and events (README.md "Webhooks", "Pairing"), read there the same
// day; and the post reads' routes and links (README.md "Covers"), read there on 2026-10-30.
import type { LinkedinDisconnectReason } from "../port.ts";

/** Vendor pages one read of engagers or of posts loads at most: a cursor that loops stops there. */
export const MAX_LOADS = 10;

/** The LinkedIn search in its posts category, newest first, as the classic API takes it. */
export const SEARCH_POSTS = { api: "classic", category: "posts", sort_by: "date" } as const;
/** The posts a search page gives at most: "technically up to 49" in Unipile's reference. */
export const SEARCH_POSTS_PAGE_MAX = 49;
/** A search result that is a post; a list of an author's posts gives no type. */
export const POST_TYPE = "POST";
/** Around a phrase, LinkedIn's exact phrase in a search. */
export const PHRASE_QUOTE = '"';
/** An account's type at Unipile when it is a LinkedIn account. */
export const LINKEDIN_ACCOUNT = "LINKEDIN";
/** A post's social id, which a /feed/update/ link names: its kind and number captured. */
export const SOCIAL_ID = /^urn:li:(activity|share|ugcPost):(\d{1,30})$/;
/** A company's id as the posts route takes it: its number; a slug is looked up first. */
export const COMPANY_ID = /^\d{1,30}$/;
/** The links the adapter makes: a post's from its social id, a member's and a company's pages. */
export const POST_LINK = "https://www.linkedin.com/feed/update/";
export const MEMBER_LINK = "https://www.linkedin.com/in/";
export const COMPANY_LINK = "https://www.linkedin.com/company/";

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

/** getCompany (company.ts): a company profile's foundation_date starts with its year. */
export const FOUNDATION_YEAR = /^(\d{4})(?:\D|$)/;
/** A website given with its scheme; a bare host (`example.com`) is read as WEB_SCHEME's. */
export const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
export const WEB_SCHEME = "https://";
