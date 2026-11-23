// A thread's channel for a reply (README.md "Replies from the inbox"), in the caller's tenant run:
// whose thread it is, the account that answers on it as linkedin's not_account_owner reads it, the
// thread's own owner once that account is gone; whether it sends now, a LinkedIn thread, connected
// and with the person's member id known; and the longest text it takes. A thread on another channel
// sends nothing until the email phase.
import { errors as contactsErrors, getPerson } from "@whytide/contacts";
import { findSenderAccount, errors as linkedinErrors, type SenderAccount } from "@whytide/linkedin";
import { isAppError } from "@whytide/platform";
import { linkedinPort } from "@whytide/providers";
import { MEMBER_REF_KEY, REPLY_CHANNEL, REPLY_TEXT_MAX } from "./constants.ts";

/** The thread as the reply reads it. */
export type ReplyThread = {
  readonly channel: string;
  readonly senderAccountId: string;
  readonly ownerUserId: string;
  readonly personId: string;
};
/** Who may reply on the thread and how: the screen's box, the route's checks. */
export type ReplyState = {
  /** The caller's own thread: the account's owner, as linkedin's not_account_owner reads it. */
  readonly own: boolean;
  /** The channel sends now: LinkedIn's, the account connected, the person's member id known. */
  readonly channelAvailable: boolean;
  /** The longest text the channel takes. */
  readonly textMax: number;
};

/** LinkedIn's longest message, the port's own, within REPLY_TEXT_MAX. */
const LINKEDIN_TEXT_MAX = Math.min(
  linkedinPort.methods.sendMessage.input.shape.text.maxLength ?? REPLY_TEXT_MAX,
  REPLY_TEXT_MAX,
);

/** The thread's account, or null once linkedin no longer holds it. */
export async function accountOf(senderAccountId: string): Promise<SenderAccount | null> {
  try {
    return await findSenderAccount(senderAccountId);
  } catch (error) {
    if (isAppError(error) && error.code === linkedinErrors.sender_account_not_found) return null;
    throw error;
  }
}

/** The person's member id at the provider, as campaigns reads it; null when unknown or erased. */
export async function memberRefOf(personId: string): Promise<string | null> {
  try {
    const refs = (await getPerson(personId)).providerRefs;
    return refs !== null && Object.hasOwn(refs, MEMBER_REF_KEY)
      ? (refs[MEMBER_REF_KEY] ?? null)
      : null;
  } catch (error) {
    if (isAppError(error) && error.code === contactsErrors.person_not_found) return null;
    throw error;
  }
}

/** Whose thread it is for `userId`, whether its channel sends now, and its longest text. */
export async function replyStateOf(thread: ReplyThread, userId: string): Promise<ReplyState> {
  const account = await accountOf(thread.senderAccountId);
  const own = (account?.ownerUserId ?? thread.ownerUserId) === userId;
  const sending = thread.channel === REPLY_CHANNEL && account?.status === "connected";
  const channelAvailable = sending && (await memberRefOf(thread.personId)) !== null;
  return { own, channelAvailable, textMax: LINKEDIN_TEXT_MAX };
}
