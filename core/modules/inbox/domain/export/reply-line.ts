// A line of the reply golden set (README.md "The reply golden set"; docs/data.md), pure: one labeled
// reply as gamma's classifier reads it, with the conversation before it. The person and the thread
// are the sha256 of their ids; the line holds no id, and the person's first and last names are masked
// in every text, as qualification's golden set leaves names out.
import { createHash } from "node:crypto";
import type { ReplyLabelValue } from "../labels/constants.ts";
import type { Direction } from "../threads/constants.ts";
import { EXPORT_EARLIER_MAX, NAME_MASKS, PATTERN_SYNTAX, WORD_CHARACTER } from "./constants.ts";

/** A message of the thread, as the line reads it. */
export type ThreadText = {
  readonly id: string;
  readonly direction: Direction;
  readonly sentBy: "campaign" | "user" | null;
  /** Personal data: the person's words, or the account's. */
  readonly body: string;
  readonly sentAt: Date;
};
/** The person's names, from contacts' getLead; null where contacts holds none. */
export type PersonNames = { readonly firstName: string | null; readonly lastName: string | null };

/** A message before the reply: who wrote it, the masked text and when it was sent. */
export type EarlierMessage = {
  readonly direction: Direction;
  readonly sent_by: "campaign" | "user" | null;
  readonly text: string;
  readonly at: string;
};
/** The line's keys, snake_case as qualification's (docs/data.md "The reply golden set's line"). */
export type ReplyLine = {
  readonly person_sha256: string;
  readonly thread_sha256: string;
  readonly label: ReplyLabelValue;
  readonly labeled_at: string;
  readonly received_at: string;
  readonly text: string;
  readonly earlier: EarlierMessage[];
};

/**
 * The line of one labeled reply. `thread` holds the thread's messages in any order, the reply among
 * them or not: `earlier` is those sent before the reply, by `sent_at` then id as the thread's page
 * orders them, the latest EXPORT_EARLIER_MAX, oldest first.
 */
export function replyLine(parts: {
  readonly personId: string;
  readonly threadId: string;
  readonly label: { readonly label: ReplyLabelValue; readonly labeledAt: Date };
  readonly reply: ThreadText & { readonly receivedAt: Date };
  readonly thread: readonly ThreadText[];
  readonly names: PersonNames;
}): ReplyLine {
  const { reply, names } = parts;
  const earlier = parts.thread
    .filter((message) => oldestFirst(message, reply) < 0)
    .sort(oldestFirst)
    .slice(-EXPORT_EARLIER_MAX)
    .map(({ direction, sentBy, body, sentAt }) => ({
      direction,
      sent_by: sentBy,
      text: maskNames(body, names),
      at: sentAt.toISOString(),
    }));
  return {
    person_sha256: sha256(parts.personId),
    thread_sha256: sha256(parts.threadId),
    label: parts.label.label,
    labeled_at: parts.label.labeledAt.toISOString(),
    received_at: reply.receivedAt.toISOString(),
    text: maskNames(reply.body, names),
    earlier,
  };
}

/**
 * The text with the person's first and last names as `[first_name]` and `[last_name]`: whole words,
 * any case, in any script (a letter, a mark, a digit or an underscore beside a name makes it part of a
 * longer word), a name of several words across any spaces. The longer name goes first, so that a name
 * inside the other ("Marie" in "Anne-Marie") cannot split it. Text and names are compared in NFC.
 */
export function maskNames(text: string, names: PersonNames): string {
  const masks = [
    { name: names.firstName, mask: NAME_MASKS.firstName },
    { name: names.lastName, mask: NAME_MASKS.lastName },
  ]
    .map(({ name, mask }) => ({ name: name?.normalize("NFC").trim() ?? "", mask }))
    .filter(({ name }) => name !== "")
    .sort((a, b) => b.name.length - a.name.length);
  let masked = text.normalize("NFC");
  for (const { name, mask } of masks) masked = masked.replace(wholeWords(name), mask);
  return masked;
}

/** The name as a pattern of whole words, any case. */
function wholeWords(name: string): RegExp {
  const words = name.split(/\s+/u).map((word) => word.replace(PATTERN_SYNTAX, "\\$&"));
  return new RegExp(`(?<!${WORD_CHARACTER})${words.join("\\s+")}(?!${WORD_CHARACTER})`, "giu");
}

/** The thread page's order: by `sent_at`, then by id, which sorts by creation. */
function oldestFirst(a: ThreadText, b: ThreadText): number {
  const time = a.sentAt.getTime() - b.sentAt.getTime();
  if (time !== 0) return time;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The sha256, in hex, of an id. */
function sha256(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}
