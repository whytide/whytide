// The replies' constants (README.md "Replies from the inbox"), beside their readers: the text's
// bound, the statuses, the workflow's id, the request file, the member id's key in contacts, and the
// waits before a check after an unknown outcome.

/**
 * The longest reply, in characters, on either channel (not in the sources); a channel may take
 * fewer.
 */
export const REPLY_TEXT_MAX = 8000;
/** A reply's send, as the table's enum: sending until it settles. */
export const SEND_STATUSES = ["sending", "sent", "refused", "failed"] as const;
export type SendStatus = (typeof SEND_STATUSES)[number];
/** inbox_send_reply's id is `<REPLY_WORKFLOW>:<workspaceId>:<messageId>`: one run per reply. */
export const REPLY_WORKFLOW = "inbox.reply";
/** The channel a reply goes out on until the email phase: another thread's is unavailable. */
export const REPLY_CHANNEL = "linkedin";
/** linkedin's action of a reply: one message, in the account's limits. */
export const REPLY_ACTION = "message";
/** A reply's request file, `raw/inbox/<messageId>/send.json`, deleted once its send settled. */
export const REQUEST_FOLDER = "raw/inbox";
export const REQUEST_FILE = "send.json";
export const REQUEST_CONTENT_TYPE = "application/json";
/** The person's member id in contacts' providerRefs, as campaigns reads it (its MEMBER_REF_KEY). */
export const MEMBER_REF_KEY = "unipile";
/** linkedin's code for a request file off its schema: a defect, the reply failed. */
export const INPUT_INVALID = "linkedin_input_invalid";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/**
 * A check after the account's retry_at, by this much: linkedin refuses one at it. And after a send
 * without an answer, so a message still on its way to the provider is in the chat when it reads it.
 */
export const CHECK_MARGIN_MS = MINUTE_MS;
/** The wait before a check when no time is known: a switch, a disconnection, a failed attempt. */
export const CHECK_WAIT_MS = HOUR_MS;
/**
 * The longest wait before a check: three of them (the workflow's REPLY_CHECKS) stay within the
 * request file's 72 hours under raw/, which the check reads.
 */
export const CHECK_WAIT_MAX_MS = 12 * HOUR_MS;
