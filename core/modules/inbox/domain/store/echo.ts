// The account's own messages, as linkedin's receiver keeps them (README.md "The platform's own
// messages"; docs/flows.md "The echo"): inbox_store_message's activity for `direction = out`, in
// one tenant run. A message a row holds already, by its provider ref, is the platform's, stored
// once by the step's event (sent.ts): nothing. Any other is the tester's, typed by hand on
// LinkedIn: the thread, the message as the user's, and a touch on the person (RB-9.2.2), so the
// gate's one touch a day holds a follow-up that day. Nothing is held: a typed message is no reply.
import { errors as contactsErrors, recordTouch } from "@whytide/contacts";
import { findSenderAccount, type MessageFile } from "@whytide/linkedin";
import { isAppError } from "@whytide/platform";
import { insertOutbound, storedMessage } from "./message.ts";
import { lockKnown } from "./person.ts";
import type { StoreResult } from "./store.ts";
import { upsertThread } from "./thread.ts";

export type EchoInput = {
  readonly personId: string;
  readonly senderAccountId: string;
  /** The message's file, parsed: the account's own, `fromAccount`. */
  readonly file: MessageFile;
  /** The store's time: received_at. */
  readonly now: Date;
};

/** What the echo answers when it stores nothing: it never holds. */
export const ECHO_UNSTORED: StoreResult = { stored: false, held: false, optOut: false };

/**
 * One message of the account's, in the caller's run, the person's lead locked first, as privacy's
 * erasure locks it before it deletes their rows: nothing for an erased person or a message stored
 * already; else the user's message, and its touch.
 */
export async function storeEcho(input: EchoInput): Promise<StoreResult> {
  const { personId, senderAccountId, file, now } = input;
  if (!(await lockKnown(personId))) return ECHO_UNSTORED;
  if (await storedMessage({ providerMessageRef: file.messageRef })) return ECHO_UNSTORED;
  const sentAt = new Date(file.sentAt);
  // The touch before any row: a person erased since the read, one without a lead to lock, has
  // none to record (person_not_found), and the run writes nothing.
  if (!(await touched(personId, sentAt))) return ECHO_UNSTORED;
  const { ownerUserId } = await findSenderAccount(senderAccountId);
  const thread = { senderAccountId, ownerUserId, personId, sentAt };
  const threadId = await upsertThread({ ...thread, providerThreadRef: file.chatRef });
  const message = { threadId, personId, body: file.text, providerMessageRef: file.messageRef };
  const messageId = await insertOutbound({ ...message, sentAt, receivedAt: now }, null);
  if (messageId === null) return ECHO_UNSTORED;
  return { stored: true, messageId, held: false, optOut: false };
}

/** The person's touch at `at` (contacts' last_touch_at, moved forward only); false once erased. */
async function touched(personId: string, at: Date): Promise<boolean> {
  try {
    await recordTouch(personId, at);
    return true;
  } catch (error) {
    if (isAppError(error) && error.code === contactsErrors.person_not_found) return false;
    throw error;
  }
}
