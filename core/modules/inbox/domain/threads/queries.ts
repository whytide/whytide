// The inbox's reads (README.md "API"), in the caller's tenant run, from inbox's tables and contacts'
// getLead only: a page of the caller's own threads, newest first, each with its person, who wrote
// last and how many replies wait for a label; and one thread of theirs with its messages, oldest
// first, each reply with its label, each reply from the inbox with its send's status, and whether the
// caller may reply on it (gamma-p4-060). Each reply carries its classification, and a thread its
// newest reply's label (gamma-p4-040): the label shown, the thread owner's when chosen, else the
// classification's with whether it is only suggested (gamma-p4-055). Each member reads the threads of
// their own senders only, whatever their role (gamma-p6-060): every read filters on owner_user_id,
// the principal's user id, and another member's thread is not found, as another workspace's is.
import { REPLY_ACTION_LABELS, type ReplyActionLabel } from "@whytide/campaigns";
import { errors as contactsErrors, getLead } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant, isAppError } from "@whytide/platform";
import { errors } from "../../errors.ts";
import type { ReplyLabelValue } from "../labels/constants.ts";
import { type ReplyState, replyStateOf } from "../reply/channel.ts";
import type { SendStatus } from "../reply/constants.ts";
import type { Direction } from "./constants.ts";
import { encodeCursor, type ThreadCursor } from "./cursor.ts";

/** The person's business fields the screens show; null once contacts no longer has the lead. */
export type ThreadPerson = {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly title: string | null;
  readonly companyName: string | null;
};
export type ThreadSummary = {
  readonly id: string;
  readonly personId: string;
  readonly person: ThreadPerson | null;
  readonly senderAccountId: string;
  readonly lastMessageAt: Date;
  /** The latest message's direction; null for a thread without one. */
  readonly lastDirection: Direction | null;
  /** The inbound messages without a label. */
  readonly toLabel: number;
  /**
   * The newest reply's label as shown: the thread owner's, not suggested, when chosen; else the
   * classification's, with whether it is only suggested; null until either.
   */
  readonly classification: Pick<Classification, "label" | "isSuggested"> | null;
};
/** A reply's classification (README.md "The classifier"). */
export type Classification = {
  readonly label: ReplyActionLabel;
  /** Under INBOX_CLASSIFY_SUGGEST_BELOW (settings.ts), or a fallback: for the member to confirm. */
  readonly isSuggested: boolean;
  readonly confidence: number;
  /** An out-of-office reply's day of return, `YYYY-MM-DD`, or null. */
  readonly returnDate: string | null;
};
export type LabelState = {
  /** Beta's word, which follows the class: positive for interested. */
  readonly label: ReplyLabelValue;
  /** The thread owner's label among the 7 (gamma-p4-055); null on a label beta's buttons chose. */
  readonly classLabel: ReplyActionLabel | null;
  /** The member who chose it. */
  readonly labeledBy: string;
  readonly labeledAt: Date;
};
export type ThreadMessage = {
  readonly id: string;
  readonly direction: Direction;
  readonly sentBy: "campaign" | "user" | null;
  /** Personal data: the person's words, or the account's, as the provider gave them. */
  readonly body: string;
  readonly sentAt: Date;
  readonly approvedAt: Date | null;
  /** A reply's label, or null: always null for an outbound message. */
  readonly label: LabelState | null;
  /** A reply's classification, or null until it is classified; null for an outbound message. */
  readonly classification: Classification | null;
  /** A reply from the inbox's send; null on every other message. */
  readonly sendStatus: SendStatus | null;
  /** The registered code a reply from the inbox was refused or failed with, or null. */
  readonly errorCode: string | null;
};
export type ThreadDetail = ThreadSummary & {
  readonly messages: ThreadMessage[];
  /** Whether the caller replies on the thread, on which channel state, and how long a text. */
  readonly reply: ReplyState;
};

type ThreadRow = Omit<ThreadSummary, "person" | "lastDirection" | "toLabel" | "classification">;
type MessageRow = { readonly id: string; readonly threadId: string; readonly direction: Direction };

const THREAD = { id: true, personId: true, senderAccountId: true, lastMessageAt: true } as const;
/** Oldest first; two messages of one instant by id, which sorts by creation. */
const OLDEST_FIRST = [{ sentAt: "asc" as const }, { id: "asc" as const }];
/** What contacts answers for a lead it no longer has: the thread shows no person. */
const GONE = new Set<string>([contactsErrors.lead_not_found, contactsErrors.person_not_found]);
/** The labels gamma writes: a row of a later one (the 15 of V1) is shown as none. */
const LABELS = new Set<string>(REPLY_ACTION_LABELS);

/** The caller, whose threads alone the reads answer: a service, as no member, owns none. */
const caller = () => currentTenant().principal.userId;

/**
 * A page of the caller's threads by last_message_at, newest first, `limit` of them after the
 * cursor (`nextCursor` of the page before); `nextCursor` is null on the last page.
 */
export async function listThreads(input: {
  readonly limit: number;
  readonly after?: ThreadCursor;
}): Promise<{ threads: ThreadSummary[]; nextCursor: string | null }> {
  const { limit, after } = input;
  const rows = await tenantClient.thread.findMany({
    where: {
      ownerUserId: caller(),
      ...(after === undefined
        ? {}
        : {
            OR: [
              { lastMessageAt: { lt: after.lastMessageAt } },
              { lastMessageAt: after.lastMessageAt, id: { lt: after.id } },
            ],
          }),
    },
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: THREAD,
  });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = rows.length > limit && last !== undefined ? encodeCursor(last) : null;
  const messages = await tenantClient.message.findMany({
    where: { threadId: { in: page.map(({ id }) => id) } },
    orderBy: OLDEST_FIRST,
    select: { id: true, threadId: true, direction: true },
  });
  const labels = await labelsOf(messages);
  const newest = page.flatMap(({ id }) => newestReply(id, messages) ?? []);
  const classified = await classificationsOf(newest);
  const persons = await personsOf(page.map(({ personId }) => personId));
  const threads = page.map((thread) =>
    summarize(thread, persons.get(thread.personId) ?? null, messages, labels, classified),
  );
  return { threads, nextCursor };
}

/**
 * The caller's thread with its person and its messages, oldest first; thread_not_found for none,
 * another workspace's or another member's, which says nothing of whose it is.
 */
export async function readThread(id: string): Promise<ThreadDetail> {
  // Prisma drops an undefined value from a where: unchecked, that would be any thread.
  if (typeof id !== "string" || id === "") throw new AppError(errors.thread_not_found);
  const user = caller();
  const select = { ...THREAD, ownerUserId: true, channel: true } as const;
  const found = await tenantClient.thread.findFirst({ where: { id, ownerUserId: user }, select });
  if (found === null) throw new AppError(errors.thread_not_found);
  const { ownerUserId, channel, ...thread } = found;
  const rows = await tenantClient.message.findMany({
    where: { threadId: id },
    orderBy: OLDEST_FIRST,
    select: {
      ...{ id: true, threadId: true, direction: true, sentBy: true, body: true },
      ...{ sentAt: true, approvedAt: true, sendStatus: true, errorCode: true },
    },
  });
  const labels = await labelsOf(rows);
  const classified = await classificationsOf(rows.filter(({ direction }) => direction === "in"));
  const persons = await personsOf([thread.personId]);
  const person = persons.get(thread.personId) ?? null;
  const summary = summarize(thread, person, rows, labels, classified);
  const messages = rows.map(({ threadId: _, ...message }) => ({
    ...message,
    label: labels.get(message.id) ?? null,
    classification: classified.get(message.id) ?? null,
  }));
  const reply = await replyStateOf({ ...thread, ownerUserId, channel }, user);
  return { ...summary, messages, reply };
}

/** The thread as the list shows it, from its messages, oldest first, the labeled and the classified. */
function summarize(
  thread: ThreadRow,
  person: ThreadPerson | null,
  messages: readonly MessageRow[],
  labels: ReadonlyMap<string, LabelState>,
  classified: ReadonlyMap<string, Classification>,
): ThreadSummary {
  const own = messages.filter(({ threadId }) => threadId === thread.id);
  const toLabel = own.filter(({ id, direction }) => direction === "in" && !labels.has(id)).length;
  const newest = newestReply(thread.id, messages)?.id ?? "";
  const classification = shownLabel(labels.get(newest), classified.get(newest));
  const lastDirection = own.at(-1)?.direction ?? null;
  return { ...thread, person, lastDirection, toLabel, classification };
}

/**
 * A reply's label as shown (RB-13.2.1, the latest): the thread owner's class, which is not a
 * suggestion, when chosen; else the classification's with its isSuggested; else none.
 */
function shownLabel(
  label: LabelState | undefined,
  classification: Classification | undefined,
): ThreadSummary["classification"] {
  if (label?.classLabel) return { label: label.classLabel, isSuggested: false };
  if (classification === undefined) return null;
  return { label: classification.label, isSuggested: classification.isSuggested };
}

/** The thread's newest reply among these messages, oldest first. */
const newestReply = (threadId: string, messages: readonly MessageRow[]) =>
  messages.findLast((message) => message.threadId === threadId && message.direction === "in");

/** The classifications of these replies, by message id; a label gamma does not write, none. */
async function classificationsOf(
  replies: readonly { readonly id: string }[],
): Promise<Map<string, Classification>> {
  if (replies.length === 0) return new Map();
  const rows = await tenantClient.replyClassification.findMany({
    where: { messageId: { in: replies.map(({ id }) => id) } },
    select: { messageId: true, label: true, isSuggested: true, confidence: true, entities: true },
  });
  return new Map(
    rows.flatMap(({ messageId, label, isSuggested, confidence, entities }) => {
      if (!LABELS.has(label)) return [];
      const returnDate = (entities as { returnDate?: string | null } | null)?.returnDate ?? null;
      const classification = { label: label as ReplyActionLabel, isSuggested, confidence };
      return [[messageId, { ...classification, returnDate }] as const];
    }),
  );
}

/** The labels of the inbound messages among these, by message id. */
async function labelsOf(messages: readonly MessageRow[]): Promise<Map<string, LabelState>> {
  const inbound = messages.filter(({ direction }) => direction === "in").map(({ id }) => id);
  if (inbound.length === 0) return new Map();
  const rows = await tenantClient.replyLabel.findMany({
    where: { messageId: { in: inbound } },
    select: { messageId: true, label: true, classLabel: true, labeledBy: true, labeledAt: true },
  });
  return new Map(
    rows.map(({ messageId, classLabel, ...label }) => {
      // The table's CHECK holds the 7 or null; anything else is shown as none.
      const known = classLabel !== null && LABELS.has(classLabel);
      return [messageId, { ...label, classLabel: known ? (classLabel as ReplyActionLabel) : null }];
    }),
  );
}

/**
 * Each person's business fields from contacts' getLead, one call per person (a page holds 50 at
 * most); null for a lead or person contacts no longer has.
 */
async function personsOf(personIds: readonly string[]): Promise<Map<string, ThreadPerson | null>> {
  const persons = new Map<string, ThreadPerson | null>();
  for (const personId of new Set(personIds)) {
    try {
      const { person } = await getLead(personId);
      const { firstName, lastName, title, companyName } = person;
      persons.set(personId, { firstName, lastName, title, companyName });
    } catch (error) {
      if (!isAppError(error) || !GONE.has(error.code)) throw error;
      persons.set(personId, null);
    }
  }
  return persons;
}
