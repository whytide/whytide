// The routes' shapes (README.md "API"; core/apps/api/README.md "OpenAPI and the client"): the list's
// query, a thread's and a message's path parameter, the label's body, a thread of the list, a thread
// with its messages, and a label. The person's names and a message's text are personal data, shown
// to the workspace's members only.
import { z } from "zod";
import { REPLY_LABELS } from "../domain/labels/constants.ts";
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
export const labelBody = z.strictObject({ label: z.enum(REPLY_LABELS) });
export type LabelBody = z.output<typeof labelBody>;

/** A reply's label: the member who chose it, and when. */
export const labelResponse = z.strictObject({
  label: z.enum(REPLY_LABELS),
  labeledBy: z.string(),
  labeledAt: time,
});
export type LabelResponse = z.output<typeof labelResponse>;
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
  label: labelResponse.nullable(),
});
export type MessageResponse = z.output<typeof message>;
/** A thread with its messages, oldest first. */
export const threadResponse = threadSummary.extend({ messages: z.array(message) });
export type ThreadResponse = z.output<typeof threadResponse>;
