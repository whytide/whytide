// The conversation as the reply writer reads it (README.md "The reply writer"): the latest
// REPLY_CHAT_MAX messages with a text, each trimmed and cut to REPLY_MESSAGE_CHARACTERS_MAX
// characters, then the oldest left out first until their UTF-8 bytes fit REPLY_CHAT_BYTES_MAX, the
// latest always kept; oldest first, each with its author and its time. Pure.
import type { ReplyChatMessage } from "../../schemas/reply.ts";
import {
  type REPLY_AUTHORS,
  REPLY_CHAT_BYTES_MAX,
  REPLY_CHAT_MAX,
  REPLY_MESSAGE_CHARACTERS_MAX,
} from "./constants.ts";

/** A message of the thread, oldest first, as its owner reads it from its own table. */
export type ChatMessage = {
  readonly from: (typeof REPLY_AUTHORS)[number];
  readonly at: Date;
  readonly text: string;
};

const encoder = new TextEncoder();
const bytesOf = (text: string) => encoder.encode(text).length;
/** A text's start, without a lone high surrogate where the cut parts a pair. */
const cut = (text: string) =>
  text.slice(0, REPLY_MESSAGE_CHARACTERS_MAX).replace(/[\uD800-\uDBFF]$/u, "");

export function replyChat(messages: readonly ChatMessage[]): ReplyChatMessage[] {
  const chat = messages
    .map(({ from, at, text }) => ({ from, at: at.toISOString(), text: cut(text.trim()) }))
    .filter(({ text }) => text !== "")
    .slice(-REPLY_CHAT_MAX);
  let bytes = chat.reduce((sum, { text }) => sum + bytesOf(text), 0);
  while (chat.length > 1 && bytes > REPLY_CHAT_BYTES_MAX) {
    bytes -= bytesOf(chat.shift()?.text ?? "");
  }
  return chat;
}
