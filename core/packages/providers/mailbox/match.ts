// The one rule (README.md "The match"; F11 §4.1; briefs RB-12.1.1): from a message's thread and
// headers, whether it belongs to the platform and which event it is; and whether a thread is the
// platform's. An adapter, and the fake, read a new message's head first (headOf: its refs, its time
// and the six HEAD_FIELDS), read the whole message only where mayMatch says it may give an event, and
// return only what eventOf gives: a message outside the match leaves no trace, no event, no log line,
// no metric label. In order: a report is read as one (reports.ts), and gives an event only when it
// names a matched Message-ID; the mailbox's own message is `sent` in a matched thread or under a
// matched Message-ID; another address's is an unsubscribe mail by its subject's prefix, else a reply
// in a matched thread or naming a matched Message-ID anywhere in In-Reply-To or References. The
// reading is pure, strings in and facts out: a message it cannot read gives no event, never an error.
import {
  FAILED_ACTION,
  FIELD_NAMES,
  MAILBOX_TEXT_MAX_CHARS,
  MESSAGE_ID_MAX_CHARS,
  REPORT_TYPE,
  SUBJECT_MAX_CHARS,
} from "./constants.ts";
import { isPlatformMessageId } from "./message-id.ts";
import {
  addressIn,
  contentTypeOf,
  cutChars,
  decodedWords,
  type HeaderField,
  messageIdOf,
  messageIdsIn,
  plainTextOf,
  valuesOf,
} from "./mime.ts";
import type { MailboxEvent, MailboxMatch } from "./port.ts";
import { readReport } from "./reports.ts";

/** What an adapter reads of a message before its body: its refs, its time and six fields. */
export type MessageHead = {
  readonly messageRef: string;
  readonly threadRef: string;
  /** The provider's time of the message: Gmail's internalDate, Graph's receivedDateTime. */
  readonly at: Date;
  readonly messageId: string | null;
  /** Every Message-ID in In-Reply-To, in order: a reply may name more than one, as References does. */
  readonly inReplyTo: readonly string[];
  readonly references: readonly string[];
  /** The From field's address, in lower case. */
  readonly from: string | null;
  /** Its encoded words decoded, trimmed, at most SUBJECT_MAX_CHARS characters. */
  readonly subject: string;
  /** A multipart/report: read as a report, never as a reply. */
  readonly report: boolean;
};
export type MailboxMatcher = {
  /** From the head alone: whether the message may give an event, so that its body is read. */
  readonly mayMatch: (head: MessageHead) => boolean;
  /** The event the whole message gives, if any. */
  readonly eventOf: (head: MessageHead, raw: string) => MailboxEvent | undefined;
};
type Refs = Pick<MessageHead, "messageRef" | "threadRef" | "at">;

/** A message's head from its header fields (HEAD_FIELDS are enough): mime.ts's, or the provider's. */
export function headOf({
  fields,
  ...refs
}: Refs & { readonly fields: readonly HeaderField[] }): MessageHead {
  // Names in lower case and values trimmed, whoever read them: a provider may keep a value's leading
  // space or fold, which would hide an unsubscribe mail's prefix.
  const named = fields.map(({ name, value }) => ({
    name: name.toLowerCase(),
    value: value.trim(),
  }));
  const first = (name: string) => valuesOf(named, name)[0];
  // An encoded word may start with a space too.
  const subject = decodedWords(first(FIELD_NAMES.subject) ?? "").trim();
  return {
    messageRef: refs.messageRef,
    threadRef: refs.threadRef,
    at: refs.at,
    messageId: messageIdOf(first(FIELD_NAMES.messageId)),
    inReplyTo: messageIdsIn(first(FIELD_NAMES.inReplyTo)),
    references: messageIdsIn(first(FIELD_NAMES.references)),
    from: addressIn(first(FIELD_NAMES.from)),
    subject: cutChars(subject, SUBJECT_MAX_CHARS),
    report: contentTypeOf(named).type === REPORT_TYPE,
  };
}

/** The match of one call: the mailbox's own address and what the caller matches on. */
export function mailboxMatcher({
  address,
  match,
}: {
  readonly address: string;
  readonly match: MailboxMatch;
}): MailboxMatcher {
  const threads = new Set(match.threadRefs);
  const ids = new Set<string>(match.messageIds);
  const prefix = match.unsubscribeSubjectPrefix;
  const kindOf = (head: MessageHead) => {
    if (head.report) return "report";
    const inThread = threads.has(head.threadRef);
    if (head.from === address)
      return inThread || (head.messageId !== null && ids.has(head.messageId)) ? "sent" : undefined;
    if (prefix !== undefined && head.subject.startsWith(prefix)) return "unsubscribe_request";
    const names = [...head.inReplyTo, ...head.references].some((id) => ids.has(id));
    return inThread || names ? "reply" : undefined;
  };
  return {
    mayMatch: (head) => kindOf(head) !== undefined,
    eventOf(head, raw) {
      const kind = kindOf(head);
      const refs = { messageRef: head.messageRef, threadRef: head.threadRef, at: head.at };
      const { messageId, subject } = head;
      if (kind === undefined) return undefined;
      if (kind === "report") return reportEvent(refs, raw, ids);
      if (kind === "unsubscribe_request") return { kind, ...refs, subject };
      const text = cutChars(plainTextOf(raw) ?? "", MAILBOX_TEXT_MAX_CHARS);
      if (kind === "sent") return { kind, ...refs, messageId, subject, text };
      const inReplyTo = answered(head.inReplyTo, head.references, ids);
      return { kind, ...refs, messageId, inReplyTo, fromAddress: head.from, subject, text };
    },
  };
}

/**
 * The reply's inReplyTo: the platform Message-ID it answers, the one the caller finds its send by.
 * In-Reply-To's matched one, else References' matched one, else In-Reply-To's first; null when none
 * reads, or it is over MESSAGE_ID_MAX_CHARS.
 */
function answered(
  inReplyTo: readonly string[],
  references: readonly string[],
  ids: ReadonlySet<string>,
): string | null {
  const matched = (named: readonly string[]) => named.find((id) => ids.has(id));
  const id = matched(inReplyTo) ?? matched(references) ?? inReplyTo[0];
  return id !== undefined && id.length <= MESSAGE_ID_MAX_CHARS ? id : null;
}

/** Whether the thread is the platform's: its earliest message sent from `address` under a Message-ID of the platform's form. */
export function isPlatformThread(heads: readonly MessageHead[], address: string): boolean {
  const earliest = byDate(heads)[0];
  return earliest?.from === address && isPlatformMessageId(earliest.messageId);
}

/**
 * readThread's selection, on a platform thread only (undefined on any other): its newest `limit`
 * messages in date order, whether older ones were left out, and the matcher that reads them, the
 * thread and its platform Message-IDs as the match.
 */
export function platformThread(
  heads: readonly MessageHead[],
  { address, threadRef, limit }: { address: string; threadRef: string; limit: number },
): { newest: MessageHead[]; more: boolean; matcher: MailboxMatcher } | undefined {
  const thread = byDate(heads.filter((head) => head.threadRef === threadRef));
  if (!isPlatformThread(thread, address)) return undefined;
  const messageIds = thread.flatMap(({ from, messageId }) =>
    from === address && isPlatformMessageId(messageId) ? [messageId] : [],
  );
  const matcher = mailboxMatcher({ address, match: { threadRefs: [threadRef], messageIds } });
  return { newest: thread.slice(-limit), more: thread.length > limit, matcher };
}

/** A bounce for a failed delivery, a complaint for a feedback report, each naming a matched Message-ID. */
function reportEvent(refs: Refs, raw: string, ids: ReadonlySet<string>): MailboxEvent | undefined {
  const report = readReport(raw);
  const originalMessageId = report?.originalMessageId;
  if (report === undefined || !originalMessageId || !ids.has(originalMessageId)) return undefined;
  if (report.kind === "feedback")
    return { kind: "complaint", ...refs, originalMessageId, feedbackType: report.feedbackType };
  const { action, status, permanent } = report;
  if (action !== FAILED_ACTION || status === null) return undefined;
  return { kind: "bounce", ...refs, originalMessageId, permanent, status };
}

/** Earliest first; ties keep the order given. */
const byDate = (heads: readonly MessageHead[]) =>
  heads.toSorted((a, b) => a.at.getTime() - b.at.getTime());
