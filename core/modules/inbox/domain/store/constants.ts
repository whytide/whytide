// The store's constants (README.md "The store", "The platform's own messages"), beside their
// readers: the thread's channel, the opt-out the store adds on a matched reply, the bounds of the ids
// and keys its inputs carry, the sent step's action a thread holds and its unmatched line's code.

/** beta's one channel: a thread is a LinkedIn chat. */
export const INBOX_CHANNEL = "linkedin";
/** contacts' opt-out for a reply that holds an opt-out phrase: the system's, with its reason code. */
export const REPLY_OPT_OUT = { source: "system", reason: "reply_opt_out" } as const;
/** The longest id an event or an input carries, as linkedin's. */
export const ID_MAX = 64;
/** The longest file key: S3's limit, which the files port's guard holds every key to. */
export const FILE_KEY_MAX = 1024;
/** inbox_store_message's id is `<STORE_WORKFLOW>:<workspaceId>:<event id>`: one run per event. */
export const STORE_WORKFLOW = "inbox.message";
/** campaigns.step_sent's action whose message a thread holds: a connection request stores nothing. */
export const SENT_ACTION = "message";
/**
 * The code of the line a sent message step without its send, its approval or its refs logs, with the
 * step's id: every `succeeded` message step has all three, so it is a defect (README.md).
 */
export const SENT_UNMATCHED = "inbox_sent_message_unmatched";
