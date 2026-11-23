// What the reply numbers read of one workspace (README.md "The report"; gamma-p7-060), in the caller's
// tenant run: the LinkedIn touches, from linkedin's send log, each step's person through campaigns'
// sentStep; every inbound message with its thread's channel, its owner's label and its
// classification; and which of those persons are signal-sourced leads (contacts' getLead). Ids,
// labels and instants only: no text is read. Nothing is written.
import { sentStep } from "@whytide/campaigns";
import { errors as contactsErrors, getLead } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { sendLogRows } from "@whytide/linkedin";
import { currentTenant, isAppError } from "@whytide/platform";
import type { ReplyLabelValue } from "../labels/constants.ts";
import { SIGNAL_SOURCE, TOUCH_KINDS } from "./constants.ts";

/** A lead touched on LinkedIn: an invite or a message a campaign step sent. */
export type Touch = { readonly personId: string; readonly at: Date };
/** An inbound message as the numbers read it. */
export type ReplyFact = {
  readonly personId: string;
  readonly channel: string;
  readonly sentAt: Date;
  /** The thread owner's label: the class among the 7, null on beta's rows, and beta's word. */
  readonly owner: { readonly classLabel: string | null; readonly label: ReplyLabelValue } | null;
  /** The reply's classification, whatever its origin; null until classified. */
  readonly classification: { readonly label: string; readonly isSuggested: boolean } | null;
};
export type WorkspaceFacts = {
  readonly workspaceId: string;
  /** The touches at or after `since`, oldest first. */
  readonly touches: readonly Touch[];
  /** Every inbound message of the workspace: the positive rule's 90 days look before `since`. */
  readonly replies: readonly ReplyFact[];
  /** The persons of the touches and replies whose lead is signal-sourced. */
  readonly signal: ReadonlySet<string>;
};

/** What contacts answers for a person it no longer has: erased, so not a signal-sourced lead. */
const GONE = new Set<string>([contactsErrors.lead_not_found, contactsErrors.person_not_found]);

/** The run's workspace's facts, the touches from `since`. */
export async function readFacts(since: Date): Promise<WorkspaceFacts> {
  const touches = await readTouches(since);
  const replies = await readReplies();
  const persons = new Set([...touches, ...replies].map(({ personId }) => personId));
  return {
    workspaceId: currentTenant().workspaceId,
    touches,
    replies,
    signal: await signalSourced(persons),
  };
}

/**
 * linkedin's `ok` invites and messages from `since`, each read through its step's send: a row naming
 * no step (a reply from the inbox names its `msg_` id) or whose step campaigns does not answer as
 * sent is no touch.
 */
async function readTouches(since: Date): Promise<Touch[]> {
  const kinds: readonly string[] = TOUCH_KINDS;
  const rows = await sendLogRows({ since });
  const persons = new Map<string, string | null>();
  const touches: Touch[] = [];
  for (const { stepExecutionId, kind, at } of rows) {
    if (stepExecutionId === null || !kinds.includes(kind)) continue;
    if (!persons.has(stepExecutionId)) {
      persons.set(stepExecutionId, (await sentStep(stepExecutionId))?.personId ?? null);
    }
    const personId = persons.get(stepExecutionId);
    if (personId) touches.push({ personId, at });
  }
  return touches;
}

/** Every inbound message, with its thread's channel, its label and its classification. */
async function readReplies(): Promise<ReplyFact[]> {
  const threads = await tenantClient.thread.findMany({ select: { id: true, channel: true } });
  const messages = await tenantClient.message.findMany({
    where: { direction: "in" },
    select: { id: true, threadId: true, personId: true, sentAt: true },
  });
  const labels = await tenantClient.replyLabel.findMany({
    select: { messageId: true, classLabel: true, label: true },
  });
  const classifications = await tenantClient.replyClassification.findMany({
    select: { messageId: true, label: true, isSuggested: true },
  });
  const channels = new Map(threads.map(({ id, channel }) => [id, channel]));
  const owners = new Map(labels.map(({ messageId, ...owner }) => [messageId, owner]));
  const classified = new Map(classifications.map(({ messageId, ...rest }) => [messageId, rest]));
  return messages.flatMap(({ id, threadId, personId, sentAt }) => {
    const channel = channels.get(threadId);
    if (channel === undefined) return [];
    const owner = owners.get(id) ?? null;
    return [{ personId, channel, sentAt, owner, classification: classified.get(id) ?? null }];
  });
}

/** The persons whose lead's first source is a signal; an erased one is not. */
async function signalSourced(persons: ReadonlySet<string>): Promise<Set<string>> {
  const signal = new Set<string>();
  for (const personId of persons) {
    try {
      if ((await getLead(personId)).sourceLabel === SIGNAL_SOURCE) signal.add(personId);
    } catch (error) {
      if (!isAppError(error) || !GONE.has(error.code)) throw error;
    }
  }
  return signal;
}
