// The messages on Unipile (README.md "Covers"): a message in the chat given, with the account's id so
// that Unipile refuses a chat of another account's, else in a chat started with the member as its
// one attendee, which Unipile answers with the member's conversation; and a chat's messages since a
// time as refs, the sender side and times, never their text, the member's chats with the account
// looked up when no chat is given. Unipile's chat routes take multipart/form-data, not JSON. Unipile
// takes no idempotency key, so the port's is dropped (README.md "Known differences"). A send it
// answers without its ids, which its reference allows, is linkedin_provider_error: the outcome is
// unknown to the caller, who checks before any retry, and no ref is made up.
import { isAppError } from "@whytide/platform";
import { z } from "zod";
import type { PortImplementation } from "../../_pattern/index.ts";
import { linkedinPort, type RecentMessage } from "../port.ts";
import { type Client, offShape, providerError, segment } from "./client.ts";
import { MAX_MESSAGE_PAGES, MEMBER_CHATS, MESSAGES_PAGE } from "./constants.ts";

type Methods = Pick<PortImplementation<typeof linkedinPort>, "sendMessage" | "listRecentMessages">;

const LIST = "listRecentMessages";
const ref = z.string().min(1).max(256);
const cursor = z.string().min(1).nullish();
const sentRef = ref.nullable();
const messageSent = z.object({ message_id: sentRef });
const chatStarted = z.object({ chat_id: sentRef, message_id: sentRef });
const chats = z.object({ items: z.array(z.object({ id: ref, account_id: z.string() })) });
const messages = z.object({
  items: z.array(
    z.object({
      id: ref,
      chat_id: ref,
      is_sender: z.union([z.literal(0), z.literal(1), z.boolean()]),
      timestamp: z.string(),
    }),
  ),
  cursor,
});

export function messaging(call: Client, now: () => number): Methods {
  return {
    sendMessage: async ({ providerAccountRef, memberRef, chatRef, text }) => {
      const method = "sendMessage";
      if (chatRef !== undefined) {
        const path = `/chats/${segment(chatRef, method)}/messages`;
        const form = { account_id: providerAccountRef, text };
        const answer = messageSent.safeParse(await call(method, { path, form }));
        if (!answer.success) throw offShape(method);
        const { message_id: messageRef } = answer.data;
        if (messageRef === null) throw unnamed(method);
        return { messageRef, chatRef, sentAt: new Date(now()) };
      }
      const form = { account_id: providerAccountRef, attendees_ids: memberRef, text };
      const answer = chatStarted.safeParse(await call(method, { path: "/chats", form }));
      if (!answer.success) throw offShape(method);
      const { chat_id: started, message_id: messageRef } = answer.data;
      if (started === null || messageRef === null) throw unnamed(method);
      return { messageRef, chatRef: started, sentAt: new Date(now()) };
    },
    listRecentMessages: async ({ providerAccountRef, memberRef, chatRef, since }) => {
      const read =
        chatRef === undefined ? await memberChats(call, providerAccountRef, memberRef) : [chatRef];
      const pages = { left: MAX_MESSAGE_PAGES };
      const found: RecentMessage[] = [];
      for (const chat of read) found.push(...(await chatMessages(call, chat, since, pages)));
      return { messages: found.toSorted((a, b) => a.sentAt.getTime() - b.sentAt.getTime()) };
    },
  };
}

/** A send answered without its ids. */
const unnamed = (method: "sendMessage") => providerError(method, { reason: "no id in the answer" });

/** The member's one-to-one chats with the account; none when Unipile knows the member in none (404). */
async function memberChats(call: Client, account: string, member: string): Promise<string[]> {
  const path = `/chat_attendees/${segment(member, LIST)}/chats`;
  const query = { account_id: account, limit: String(MEMBER_CHATS) };
  let answer: unknown;
  try {
    answer = await call(LIST, { path, query });
  } catch (error) {
    if (isAppError(error) && error.code === linkedinPort.errors.linkedin_not_found) return [];
    throw error;
  }
  const found = chats.safeParse(answer);
  if (!found.success) throw offShape(LIST);
  return found.data.items.filter((chat) => chat.account_id === account).map((chat) => chat.id);
}

/** A chat's messages since `since`, every page; a time that does not parse fails the call. */
async function chatMessages(call: Client, chat: string, since: Date, pages: { left: number }) {
  const found: RecentMessage[] = [];
  let next: string | null = null;
  do {
    if (--pages.left < 0) throw providerError(LIST, { reason: "too many vendor pages" });
    const path = `/chats/${segment(chat, LIST)}/messages`;
    const query = {
      after: since.toISOString(),
      limit: String(MESSAGES_PAGE),
      ...(next === null ? {} : { cursor: next }),
    };
    const answer = messages.safeParse(await call(LIST, { path, query }));
    if (!answer.success) throw offShape(LIST);
    for (const { id, chat_id: chatRef, is_sender: sender, timestamp } of answer.data.items) {
      const at = Date.parse(timestamp);
      if (Number.isNaN(at)) throw offShape(LIST);
      if (at < since.getTime()) continue;
      const fromAccount = sender === 1 || sender === true;
      found.push({ messageRef: id, chatRef, fromAccount, sentAt: new Date(at) });
    }
    next = answer.data.cursor ?? null;
  } while (next !== null);
  return found;
}
