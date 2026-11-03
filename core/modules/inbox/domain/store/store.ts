// The store's run (README.md "The store"; architecture §14.3): an inbound message in the caller's
// tenant run, in this order: the hold, always; with the file and a person contacts still knows, the
// thread, the message (a repeat ends the run there), the opt-out on a matched phrase and
// inbox.reply_received. All of it commits together or not at all, so the stop takes no longer than
// the store. No model: the phrase list decides (domain/opt-out/).
import { holdForReply } from "@whytide/campaigns";
import { addOptOut } from "@whytide/contacts";
import { outboxWriter, tenantClient } from "@whytide/db";
import { findSenderAccount, type MessageFile } from "@whytide/linkedin";
import { currentTenant, publish } from "@whytide/platform";
import { events } from "../../events.ts";
import { matchesOptOut } from "../opt-out/match.ts";
import { REPLY_OPT_OUT } from "./constants.ts";
import { insertInbound } from "./message.ts";
import { known } from "./person.ts";
import { upsertThread } from "./thread.ts";

/** What the store answers, ids and booleans only: never the text. */
export type StoreResult = {
  /**
   * This run stored the message: false without a file, for a repeat (the platform's own message's
   * echo among them) and for an erased person.
   */
  readonly stored: boolean;
  readonly messageId?: string;
  /** The person's pending steps are held: true for every inbound message. */
  readonly held: boolean;
  /** This run found an opt-out phrase and suppressed the person. */
  readonly optOut: boolean;
};

export type InboundInput = {
  readonly personId: string;
  readonly senderAccountId: string;
  /** The message's file, parsed; null when it is missing or invalid, which the hold alone follows. */
  readonly file: MessageFile | null;
  /** The store's time: received_at, and the hold's instant when there is no file. */
  readonly now: Date;
};

/** What the run answers when it stores nothing: the hold ran all the same. */
const UNSTORED: StoreResult = { stored: false, held: true, optOut: false };

/** One inbound message: the hold, then the message and what follows it, in the caller's run. */
export async function storeInbound(input: InboundInput): Promise<StoreResult> {
  const { personId, senderAccountId, file, now } = input;
  const at = file === null ? now : new Date(file.sentAt);
  // First and always: a reply stops the sequence, whether or not its text arrived.
  await holdForReply(personId, { at });
  if (file === null) return UNSTORED;
  // A person erased since the message came: nothing of theirs is written back, so the erasure
  // sticks, and the caller deletes the file. Read after the hold's lock on the lead, which an
  // erasure deleting that lead holds until it commits.
  if (!(await known(personId))) return UNSTORED;
  const { ownerUserId } = await findSenderAccount(senderAccountId);
  const thread = { senderAccountId, ownerUserId, personId, sentAt: at };
  const threadId = await upsertThread({ ...thread, providerThreadRef: file.chatRef });
  const optOut = matchesOptOut(file.text);
  const messageId = await insertInbound({
    ...{ threadId, personId, body: file.text, providerMessageRef: file.messageRef },
    ...{ sentAt: at, receivedAt: now, optOutMatched: optOut },
  });
  if (messageId === null) return UNSTORED;
  // When in doubt, suppress (F12 R2): a matched phrase is enough, whatever else the reply says.
  if (optOut) await addOptOut(personId, REPLY_OPT_OUT);
  const writer = outboxWriter(tenantClient, currentTenant().workspaceId);
  const reply = { messageId, threadId, personId };
  await publish(writer, events["inbox.reply_received"], reply);
  return { stored: true, messageId, held: true, optOut };
}
