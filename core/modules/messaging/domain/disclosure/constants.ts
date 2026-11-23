// The AI disclosure line's values (README.md "The disclosure line"; gamma-p4-080): its message key
// per channel, its language and what joins it to a text. Plain values; nothing imported but a type.
import type { DisclosureChannel } from "../../schemas/writer.ts";

/**
 * Each channel's line in messages/en.json. Its text is a draft until counsel's replaces it before
 * V1: the key's text changes, never the code (briefs RB-14.2.1, RB-20.6.1).
 */
export const DISCLOSURE_KEYS: Readonly<Record<DisclosureChannel, string>> = {
  linkedin_message: "messaging.disclosure.linkedin",
  email: "messaging.disclosure.email",
};
/** The line's language: the drafts', English only in gamma (RB-20.6.1, reduced). */
export const DISCLOSURE_LOCALE = "en";
/** What joins a text and its line: a blank line. */
export const DISCLOSURE_SEPARATOR = "\n\n";
