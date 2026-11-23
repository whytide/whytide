// The routes' shapes (README.md "API"; core/apps/api/README.md "OpenAPI and the client"): the list's
// query, a thread's and a message's path parameter, the label's body, a thread of the list, a thread
// with its messages and whether the caller replies on it, and a label; a reply's classification, and
// a thread's newest reply's label (gamma-p4-040); the label's body, one of campaigns' 7, and a label's
// class (gamma-p4-055). The person's names and a message's text are personal data, shown to the
// workspace's members only.
import { REPLY_ACTION_LABELS } from "@whytide/campaigns";
import { z } from "zod";
import { REPLY_LABELS } from "../domain/labels/constants.ts";
import { REPLY_TEXT_MAX, SEND_STATUSES } from "../domain/reply/constants.ts";
import { ID_MAX } from "../domain/store/constants.ts";
import { CURSOR_MAX, DIRECTIONS, SENDERS, THREADS_PAGE_MAX } from "../domain/threads/constants.ts";
import { decodeCursor } from "../domain/threads/cursor.ts";

const id = z.string().min(1).max(ID_MAX);
const time = z.iso.datetime();

export const threadsQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(THREADS_PAGE_MAX).default(THREADS_PAGE_MAX),
  /** The `nextCursor` of the page before. */
  cursor: z
    .string()
    .min(1)
    .max(CURSOR_MAX)
    .refine((cursor) => decodeCursor(cursor) !== null)
    .optional(),
});
export type ThreadsQuery = z.output<typeof threadsQuery>;
/** A thread's or a message's id. */
export const idParams = z.strictObject({ id });
/** One of the 7 labels: beta's positive and not_positive are refused (validation_failed). */
export const labelBody = z.strictObject({ label: z.enum(REPLY_ACTION_LABELS) });
export type LabelBody = z.output<typeof labelBody>;

/** A reply's label: the thread owner's class, beta's word that follows it, who chose it, and when. */
const labelState = z.strictObject({
  /** positive for interested, not_positive for the six others. */
  label: z.enum(REPLY_LABELS),
  /** One of the 7; null on a label beta's buttons chose. */
  classLabel: z.enum(REPLY_ACTION_LABELS).nullable(),
  labeledBy: z.string(),
  labeledAt: time,
});
export type MessageLabel = z.output<typeof labelState>;
/** The label as the PUT sets it: its class always. */
export const labelResponse = labelState.extend({ classLabel: z.enum(REPLY_ACTION_LABELS) });
export type LabelResponse = z.output<typeof labelResponse>;
/** A reply's classification (README.md "The classifier"): suggested under the setting, or a fallback. */
const classification = z.strictObject({
  label: z.enum(REPLY_ACTION_LABELS),
  isSuggested: z.boolean(),
  confidence: z.number().min(0).max(1),
  /** An out-of-office reply's day of return, or null. */
  returnDate: z.iso.date().nullable(),
});
/** The lead's business fields, from contacts; null once contacts no longer has the lead. */
const person = z.strictObject({
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  title: z.string().nullable(),
  companyName: z.string().nullable(),
});
export const threadSummary = z.strictObject({
  id,
  personId: id,
  person: person.nullable(),
  senderAccountId: id,
  lastMessageAt: time,
  /** Who wrote last: the person (`in`) or the account (`out`); null without a message. */
  lastDirection: z.enum(DIRECTIONS).nullable(),
  /** The replies without a label. */
  toLabel: z.int().min(0),
  /**
   * The newest reply's label as shown: the thread owner's, not suggested, when chosen; else the
   * classification's and whether it is only suggested; null until either.
   */
  classification: classification.pick({ label: true, isSuggested: true }).nullable(),
});
export type ThreadSummaryResponse = z.output<typeof threadSummary>;
export const threadPage = z.strictObject({
  threads: z.array(threadSummary),
  nextCursor: z.string().nullable(),
});
export type ThreadPage = z.output<typeof threadPage>;
const message = z.strictObject({
  id,
  direction: z.enum(DIRECTIONS),
  /** An outbound message's sender: the campaign, approved; or the user, typed on LinkedIn. */
  sentBy: z.enum(SENDERS).nullable(),
  body: z.string(),
  sentAt: time,
  approvedAt: time.nullable(),
  /** A reply's label, null until one is chosen; always null for an outbound message. */
  label: labelState.nullable(),
  /** A reply's classification, null until it is classified; always null for an outbound message. */
  classification: classification.nullable(),
  /** A reply from the inbox's send: sending until it settles; null on every other message. */
  sendStatus: z.enum(SEND_STATUSES).nullable(),
  /** The code a reply from the inbox was refused or failed with, or null. */
  errorCode: z.string().nullable(),
});
export type MessageResponse = z.output<typeof message>;
/** Whether the caller replies on the thread (README.md "Replies from the inbox"). */
const replyState = z.strictObject({
  /** The caller owns the thread's account: only they reply on it. */
  own: z.boolean(),
  /** The channel sends now: the account connected, the person's member id known. */
  channelAvailable: z.boolean(),
  /** The longest text the channel takes. */
  textMax: z.int().min(1).max(REPLY_TEXT_MAX),
});
/** A thread with its messages, oldest first, and the caller's reply state. */
export const threadResponse = threadSummary.extend({
  messages: z.array(message),
  reply: replyState,
});
export type ThreadResponse = z.output<typeof threadResponse>;
