// The reply golden set (README.md "The reply golden set"): a line per labeled reply of the workspace,
// or of one ISO week's labels (reply-line.ts), written through the files port under the workspace's
// exports/ and given back with its counts. The labels are read in one tenant run, their lines
// EXPORT_PAGE labels a run, from inbox's tables and contacts' getLead, and the file is written outside
// any run. The route's file holds the caller's own threads only (`owner`, gamma-p6-060); the
// operator's command, which no member runs, every thread. gamma-p7-060: each line carries its
// thread's channel, the owner's class and the reply's classification, read in the same runs. Nothing
// here logs: the lines hold the conversations' texts.
import { errors as contactsErrors, getLead } from "@whytide/contacts";
import { tenantClient, withTenant } from "@whytide/db";
import { isAppError, type TenantContext } from "@whytide/platform";
import { filesConfig, filesPort, getAdapter } from "@whytide/providers";
import type { ReplyLabelValue } from "../labels/constants.ts";
import { givenClient } from "./client.ts";
import {
  EXPORT_FILE_PREFIX,
  EXPORT_FILE_SUFFIX,
  EXPORT_FOLDER,
  EXPORT_PAGE,
  JSONL,
  UTC_DATE_LENGTH,
} from "./constants.ts";
import {
  type PersonNames,
  type ReplyLine,
  replyLine,
  type StoredClassification,
  type ThreadText,
} from "./reply-line.ts";
import { type WeekRange, weekRange } from "./week.ts";

export type ReplyLabelsFile = {
  /** The whole key, `w/<workspaceId>/exports/reply-labels-<UTC date or ISO week>.jsonl`. */
  readonly key: string;
  readonly lines: number;
  /** The lines labeled positive. */
  readonly positive: number;
  /**
   * identity's ids of the owners of the threads that hold a positive line, each once: the testers who
   * got a positive reply, for the command's totals. Never printed, answered or logged.
   */
  readonly positiveOwners: readonly string[];
  readonly body: string;
};

type LabelRow = {
  readonly messageId: string;
  readonly label: ReplyLabelValue;
  readonly classLabel: string | null;
  readonly labeledAt: Date;
};
type Built = { readonly line: ReplyLine; readonly ownerUserId: string };

const TEXT = { id: true, direction: true, sentBy: true, body: true, sentAt: true } as const;
const CLASSIFICATION = {
  ...{ messageId: true, label: true, confidence: true, isSuggested: true, origin: true },
  promptVersion: true,
} as const;
/** What contacts answers for a person it no longer has: erased, so the reply has no line. */
const GONE = new Set<string>([contactsErrors.lead_not_found, contactsErrors.person_not_found]);

/**
 * The workspace's reply golden set, every label or, with `week`, those chosen in that ISO week, in
 * the order they were chosen, and with `owner` only the replies of that user's threads (a member's
 * own, the route's); written to `exports/reply-labels-<UTC date>.jsonl`, or
 * `reply-labels-<ISO week>.jsonl` with `week`, so that a week's export leaves the day's full one in
 * place; a second export of the same name replaces it. week_invalid for a week its year does not
 * have or that has not started; files_too_large past 25 MiB.
 */
export async function exportReplyLabels(
  tenant: TenantContext,
  view: { readonly week?: string; readonly owner?: string },
  now: Date = new Date(),
): Promise<ReplyLabelsFile> {
  const range = view.week === undefined ? undefined : weekRange(view.week, now);
  const inRun = <T>(fn: () => Promise<T>) => withTenant(tenant, fn, { client: givenClient() });
  const labels = await inRun(() => labelRows(range, view.owner));
  const built: Built[] = [];
  for (let at = 0; at < labels.length; at += EXPORT_PAGE) {
    built.push(...(await inRun(() => linesOf(labels.slice(at, at + EXPORT_PAGE)))));
  }
  const positives = built.filter(({ line }) => line.label === "positive");
  const body = built.map(({ line }) => `${JSON.stringify(line)}\n`).join("");
  const name = view.week ?? now.toISOString().slice(0, UTC_DATE_LENGTH);
  const key = `${EXPORT_FOLDER}${EXPORT_FILE_PREFIX}${name}${EXPORT_FILE_SUFFIX}`;
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  const { workspaceId } = tenant;
  const stored = await files.put({ workspaceId, key, body, contentType: JSONL });
  return {
    key: stored.key,
    lines: built.length,
    positive: positives.length,
    positiveOwners: [...new Set(positives.map(({ ownerUserId }) => ownerUserId))],
    body,
  };
}

/**
 * The labels, oldest first, all or those chosen in the week, of every thread or of the owner's:
 * one row per reply, its latest label. The tenant client refuses a relation in a where, so the
 * owner's replies are read first, by their threads.
 */
async function labelRows(
  range: WeekRange | undefined,
  owner: string | undefined,
): Promise<LabelRow[]> {
  const replies = owner === undefined ? undefined : await repliesOf(owner);
  return tenantClient.replyLabel.findMany({
    where: {
      ...(range === undefined ? {} : { labeledAt: { gte: range.start, lt: range.end } }),
      ...(replies === undefined ? {} : { messageId: { in: replies } }),
    },
    orderBy: [{ labeledAt: "asc" }, { id: "asc" }],
    select: { messageId: true, label: true, classLabel: true, labeledAt: true },
  });
}

/** The ids of the inbound messages of the owner's threads: a member's own replies. */
async function repliesOf(owner: string): Promise<string[]> {
  const threads = await tenantClient.thread.findMany({
    where: { ownerUserId: owner },
    select: { id: true },
  });
  const replies = await tenantClient.message.findMany({
    where: { threadId: { in: threads.map(({ id }) => id) }, direction: "in" },
    select: { id: true },
  });
  return replies.map(({ id }) => id);
}

/**
 * The lines of these labels, in their order, in the caller's tenant run: each inbound message with
 * its thread's channel and messages, its classification and its person's names. A label of an
 * outbound message has none, nor one whose reply, thread or person was erased since the labels were
 * read.
 */
async function linesOf(labels: readonly LabelRow[]): Promise<Built[]> {
  const replies = await tenantClient.message.findMany({
    where: { id: { in: labels.map(({ messageId }) => messageId) }, direction: "in" },
    select: { ...TEXT, threadId: true, receivedAt: true, optOutMatched: true },
  });
  const classifications = await tenantClient.replyClassification.findMany({
    where: { messageId: { in: replies.map(({ id }) => id) } },
    select: CLASSIFICATION,
  });
  const threadIds = [...new Set(replies.map(({ threadId }) => threadId))];
  const threads = await tenantClient.thread.findMany({
    where: { id: { in: threadIds } },
    select: { id: true, channel: true, personId: true, ownerUserId: true },
  });
  const rows = await tenantClient.message.findMany({
    where: { threadId: { in: threadIds } },
    select: { ...TEXT, threadId: true },
  });
  const texts: Map<string, ThreadText[]> = Map.groupBy(rows, ({ threadId }) => threadId);
  const persons = await namesOf(threads.map(({ personId }) => personId));
  const repliesById = new Map(replies.map((reply) => [reply.id, reply]));
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const classified = new Map<string, StoredClassification>(
    classifications.map(({ messageId, ...stored }) => [messageId, stored]),
  );
  const built: Built[] = [];
  for (const label of labels) {
    const reply = repliesById.get(label.messageId);
    const thread = reply && threadsById.get(reply.threadId);
    const names = thread && persons.get(thread.personId);
    if (!reply || !thread || !names) continue;
    const line = replyLine({
      ...{ personId: thread.personId, threadId: thread.id, channel: thread.channel },
      ...{ label, reply, names, classification: classified.get(reply.id) ?? null },
      thread: texts.get(thread.id) ?? [],
    });
    built.push({ line, ownerUserId: thread.ownerUserId });
  }
  return built;
}

/**
 * Each person's first and last names from contacts' getLead, one call per person (a page holds
 * EXPORT_PAGE replies at most); null for one contacts no longer has.
 */
async function namesOf(personIds: readonly string[]): Promise<Map<string, PersonNames | null>> {
  const names = new Map<string, PersonNames | null>();
  for (const personId of new Set(personIds)) {
    try {
      const { person } = await getLead(personId);
      names.set(personId, { firstName: person.firstName, lastName: person.lastName });
    } catch (error) {
      if (!isAppError(error) || !GONE.has(error.code)) throw error;
      names.set(personId, null);
    }
  }
  return names;
}
