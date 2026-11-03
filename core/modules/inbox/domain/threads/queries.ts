// The inbox's reads (README.md "API"), in the caller's tenant run, from inbox's tables and contacts'
// getLead only: a page of the workspace's threads, newest first, each with its person, who wrote
// last and how many replies wait for a label; and one thread with its messages, oldest first, each
// reply with its label. Every member reads every thread: the receiver keeps only the platform's.
import { errors as contactsErrors, getLead } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { AppError, isAppError } from "@whytide/platform";
import { errors } from "../../errors.ts";
import type { ReplyLabelValue } from "../labels/constants.ts";
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
};
export type LabelState = {
  readonly label: ReplyLabelValue;
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
};
export type ThreadDetail = ThreadSummary & { readonly messages: ThreadMessage[] };

type ThreadRow = Omit<ThreadSummary, "person" | "lastDirection" | "toLabel">;
type MessageRow = { readonly id: string; readonly threadId: string; readonly direction: Direction };

const THREAD = { id: true, personId: true, senderAccountId: true, lastMessageAt: true } as const;
/** Oldest first; two messages of one instant by id, which sorts by creation. */
const OLDEST_FIRST = [{ sentAt: "asc" as const }, { id: "asc" as const }];
/** What contacts answers for a lead it no longer has: the thread shows no person. */
const GONE = new Set<string>([contactsErrors.lead_not_found, contactsErrors.person_not_found]);

/**
 * A page of the workspace's threads by last_message_at, newest first, `limit` of them after the
 * cursor (`nextCursor` of the page before); `nextCursor` is null on the last page.
 */
export async function listThreads(input: {
  readonly limit: number;
  readonly after?: ThreadCursor;
}): Promise<{ threads: ThreadSummary[]; nextCursor: string | null }> {
  const { limit, after } = input;
  const rows = await tenantClient.thread.findMany({
    where:
      after === undefined
        ? {}
        : {
            OR: [
              { lastMessageAt: { lt: after.lastMessageAt } },
              { lastMessageAt: after.lastMessageAt, id: { lt: after.id } },
            ],
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
  const labeled = new Set((await labelsOf(messages)).keys());
  const persons = await personsOf(page.map(({ personId }) => personId));
  const threads = page.map((thread) =>
    summarize(thread, persons.get(thread.personId) ?? null, messages, labeled),
  );
  return { threads, nextCursor };
}

/** The thread with its person and its messages, oldest first; thread_not_found. */
export async function readThread(id: string): Promise<ThreadDetail> {
  // Prisma drops an undefined value from a where: unchecked, that would be any thread.
  if (typeof id !== "string" || id === "") throw new AppError(errors.thread_not_found);
  const thread = await tenantClient.thread.findFirst({ where: { id }, select: THREAD });
  if (thread === null) throw new AppError(errors.thread_not_found);
  const rows = await tenantClient.message.findMany({
    where: { threadId: id },
    orderBy: OLDEST_FIRST,
    select: {
      ...{ id: true, threadId: true, direction: true, sentBy: true, body: true },
      ...{ sentAt: true, approvedAt: true },
    },
  });
  const labels = await labelsOf(rows);
  const persons = await personsOf([thread.personId]);
  const summary = summarize(thread, persons.get(thread.personId) ?? null, rows, labels);
  const messages = rows.map(({ threadId: _, ...message }) => ({
    ...message,
    label: labels.get(message.id) ?? null,
  }));
  return { ...summary, messages };
}

/** The thread as the list shows it, from its messages, oldest first, and the labeled ones. */
function summarize(
  thread: ThreadRow,
  person: ThreadPerson | null,
  messages: readonly MessageRow[],
  labeled: { has: (messageId: string) => boolean },
): ThreadSummary {
  const own = messages.filter(({ threadId }) => threadId === thread.id);
  const toLabel = own.filter(({ id, direction }) => direction === "in" && !labeled.has(id)).length;
  return { ...thread, person, lastDirection: own.at(-1)?.direction ?? null, toLabel };
}

/** The labels of the inbound messages among these, by message id. */
async function labelsOf(messages: readonly MessageRow[]): Promise<Map<string, LabelState>> {
  const inbound = messages.filter(({ direction }) => direction === "in").map(({ id }) => id);
  if (inbound.length === 0) return new Map();
  const rows = await tenantClient.replyLabel.findMany({
    where: { messageId: { in: inbound } },
    select: { messageId: true, label: true, labeledBy: true, labeledAt: true },
  });
  return new Map(rows.map(({ messageId, ...label }) => [messageId, label]));
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
