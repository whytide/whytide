// The classifier's input and output (agents/classify-reply/README.md; gamma-p4-040). The input, a
// field per data block: <thread>, the reply's thread's last CLASSIFY_THREAD_MESSAGES messages before
// it, oldest first, each its author and day; <reply>, its day and text. Every text's links, email
// addresses and phone numbers are masked here again (domain/classify/mask.ts), whatever the caller
// sent; the names the caller masks, which only it knows. A key the schema does not declare is dropped
// before a block is written. The output: one of the 7 labels gamma writes (campaigns'
// REPLY_ACTION_LABELS, imported, so that the two lists cannot differ), a confidence from 0 to 1, and
// an out-of-office reply's return date, `YYYY-MM-DD`, or null.
import { REPLY_ACTION_LABELS } from "@whytide/campaigns";
import { z } from "zod";
import { CLASSIFY_TEXT_MAX, CLASSIFY_THREAD_MESSAGES } from "../domain/classify/constants.ts";
import { maskPatterns } from "../domain/classify/mask.ts";

export const CLASSIFY_REPLY = "inbox.classify-reply";
/** Who wrote a message of the thread, in the words the prompt uses: the person, or the account. */
export const CLASSIFY_AUTHORS = ["lead", "seller"] as const;

const day = z.iso.date();
const text = (max: number) => z.string().max(max).transform(maskPatterns);

export const classifyReplyInput = z.object({
  thread: z
    .array(z.object({ from: z.enum(CLASSIFY_AUTHORS), day, text: text(CLASSIFY_TEXT_MAX.thread) }))
    .max(CLASSIFY_THREAD_MESSAGES),
  reply: z.object({ day, text: text(CLASSIFY_TEXT_MAX.reply) }),
});
export type ClassifyReplyInput = z.input<typeof classifyReplyInput>;

export const classifyReplyOutput = z.object({
  label: z.enum(REPLY_ACTION_LABELS),
  confidence: z.number().min(0).max(1),
  returnDate: day.nullable(),
});
export type ClassifyReplyOutput = z.output<typeof classifyReplyOutput>;
