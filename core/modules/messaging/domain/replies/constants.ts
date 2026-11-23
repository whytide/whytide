// The reply writer's values (README.md "The reply writer"; inbox-reply-draft): plain values, read by
// the domain and the schemas; nothing imported.

/** The conversation's latest messages the writer reads, oldest first; the earlier ones left out. */
export const REPLY_CHAT_MAX = 20;
/** A message's text, at most, as the writer reads it: the start of a longer one (not in the sources). */
export const REPLY_MESSAGE_CHARACTERS_MAX = 2_000;
/**
 * The conversation's UTF-8 bytes, at most, within the task's input budget (ai's estimate counts a
 * byte a third of a token): the oldest messages are left out first, the latest always kept.
 */
export const REPLY_CHAT_BYTES_MAX = 24_000;
/** The member's brief, trimmed, at most: inbox's route holds it to the same. */
export const REPLY_BRIEF_MAX = 2_000;
/** A failed answer is written again once, with its issues in <failures>, then the reply fails. */
export const REPLY_REWRITES = 1;
/** Who wrote a message of the conversation: the lead, or the seller and their campaign. */
export const REPLY_AUTHORS = ["lead", "seller"] as const;
