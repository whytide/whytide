// The setup the replies' tests share (tests/safety/reply-from-inbox.test.ts, tests/reply.test.ts),
// each file on its own schema (withTestDb, called by the file), on top of fixtures.ts: linkedin's
// clock and the replies' on a past Thursday at 10:00 UTC, inside the account's hours whatever day
// the tests run; a thread of the owner's connected account with a person whose member id contacts
// knows; the route's run as a member (a human principal); the workflow's activities' bodies in a
// run of the workspace's; linkedin's settle of the slot as its send activity leaves it; and the
// rows, the slots and the request file as the tests read them.
import { randomUUID } from "node:crypto";
import { text } from "node:stream/consumers";
import { createLeadForPerson, recordLeadStatus, upsertPersonFromSource } from "@whytide/contacts";
import { withTenant } from "@whytide/db";
import { asRole } from "@whytide/db/testing";
import { commitSend, releaseSend } from "@whytide/linkedin";
import {
  createConnectedAccount,
  createOutreach,
  openSending,
  useClock,
} from "@whytide/linkedin/testing";
import type { Principal } from "@whytide/platform";
import { filesPort, getAdapter, type LinkedinFake, linkedinPort } from "@whytide/providers";
import { requestReply } from "../domain/reply/request.ts";
import { createMessage, createThread, useReplyClock } from "../testing/index.ts";
import { beginReply, requestKeyOf, type SettleInput, settleReplyRun } from "../workflows/reply.ts";
import { fixture, OWNER } from "./fixtures.ts";

/** Thursday 22 October 2026, 10:00 UTC: a weekday, in the past, inside the default hours. */
export const THURSDAY = new Date("2026-10-22T10:00:00Z");
/** The person's reply on the thread, an hour before THURSDAY. */
const REPLIED_AT = new Date(THURSDAY.getTime() - 3_600_000);
/** Another member of the workspace, who owns no account. */
export const MEMBER = "usr_inbox_member";
export const TEXT = "Thanks Noor, Tuesday at 3 works. I will send an invite.";

/** linkedin's time and the replies', from THURSDAY at the system's pace. */
export function useThursday(): () => Date {
  const offset = THURSDAY.getTime() - Date.now();
  const now = () => new Date(Date.now() + offset);
  useClock(now);
  useReplyClock(now);
  return now;
}

/** A member's principal in the workspace, as the api's guard builds it. */
export const human = (userId: string, workspaceId: string): Principal => ({
  userId,
  actorType: "human",
  authMethod: "session",
  workspaceId,
  role: "Member",
  scopes: [],
});

/** A reply's row as the tests read it. */
export type ReplyRow = {
  readonly direction: string;
  readonly sentBy: string | null;
  readonly body: string;
  readonly sendStatus: string | null;
  readonly errorCode: string | null;
  readonly createdBy: string | null;
  readonly providerMessageRef: string | null;
  readonly sentAt: Date;
};

/** The helpers of one workspace, sending open. */
export function replyFixture(workspaceId: string) {
  const base = fixture(workspaceId);
  const { app, run } = base;
  const context = { workspaceId, tenant: run };
  const files = () => getAdapter(filesPort, "fake");

  /**
   * The owner's connected account, a person with a member id and a lead, their thread with a
   * reply.
   */
  async function ready(slug: string) {
    await openSending();
    const { id: accountId } = await createConnectedAccount(workspaceId, { ownerUserId: OWNER });
    const memberRef = `member-${randomUUID()}`;
    const personId = await run(async () => {
      const linkedinUrl = `https://linkedin.com/in/${slug}-${randomUUID().slice(0, 8)}`;
      const profile = { linkedinUrl, providerId: memberRef, firstName: "Noor" };
      const source = { source: "linkedin", provider: "unipile", profile } as const;
      const { person } = await upsertPersonFromSource(source);
      await createLeadForPerson({
        personId: person.id,
        source: { kind: "imported", ref: "imp_1" },
      });
      const actor = { type: "system" } as const;
      await recordLeadStatus(person.id, "approved", { actor });
      await recordLeadStatus(person.id, "in_campaign", { actor, templateId: "linkedin_default" });
      return person.id;
    });
    const chatRef = `chat-${randomUUID()}`;
    const thread = { workspaceId, personId, senderAccountId: accountId, ownerUserId: OWNER };
    const threadId = await createThread({
      ...{ ...thread, providerThreadRef: chatRef, lastMessageAt: REPLIED_AT },
    });
    const body = "Happy to talk next week.";
    await createMessage({ workspaceId, threadId, personId, body, sentAt: REPLIED_AT });
    return { accountId, personId, memberRef, threadId, chatRef };
  }

  return {
    ...base,
    ready,
    /** The route's run as `userId`, the owner unless given: the reply's message and status. */
    press: (threadId: string, text = TEXT, userId = OWNER) =>
      withTenant(
        { workspaceId, principal: human(userId, workspaceId) },
        () => requestReply(threadId, text),
        { client: app() },
      ),
    /** inbox_reply_begin's body. */
    begin: (messageId: string) => beginReply(context, { workspaceId, messageId }),
    /** inbox_reply_settle's body on linkedin's answer. */
    settle: (input: Omit<SettleInput, "workspaceId">) =>
      settleReplyRun(context, { workspaceId, ...input }),
    /** The slot as linkedin's send activity leaves it: counted, or freed. */
    async commit(reservationId: string): Promise<void> {
      await run(() => commitSend(reservationId));
    },
    release: (reservationId: string): Promise<void> => run(() => releaseSend(reservationId)),
    /**
     * The person's outreach row as linkedin's send leaves it once the reply went out in the chat:
     * the message's refs, the provider's time, and the reply's message as its last send.
     */
    async sentOut(
      sent: { accountId: string; personId: string; chatRef: string },
      messageId: string,
      sentAt: Date,
    ) {
      const refs = { chatRef: sent.chatRef, messageRef: `message-${randomUUID()}` };
      const { accountId, personId } = sent;
      const row = { senderAccountId: accountId, personId, providerChatRef: refs.chatRef };
      const { id } = await createOutreach(workspaceId, row);
      const data = {
        lastStepExecutionId: messageId,
        lastMessageRef: refs.messageRef,
        lastSentAt: sentAt,
      };
      await app().senderOutreach.update({ where: { id }, data });
      return refs;
    },
    rowOf: (messageId: string): Promise<ReplyRow> =>
      app().message.findUniqueOrThrow({
        where: { id: messageId },
        select: {
          ...{ direction: true, sentBy: true, body: true, sendStatus: true, errorCode: true },
          ...{ createdBy: true, providerMessageRef: true, sentAt: true },
        },
      }),
    /** The replies of the workspace: its rows with a send's status. */
    replies: async (): Promise<number> =>
      app().message.count({ where: { workspaceId, sendStatus: { not: null } } }),
    /** linkedin's reservations under the reply's key, as [id, status]. */
    slotsOf: async (messageId: string) =>
      (
        await app().senderQuotaReservation.findMany({
          where: { idempotencyKey: messageId },
          orderBy: { createdAt: "asc" },
        })
      ).map(({ id, status }) => [id, status]),
    /** The reply's request file, parsed, or null when none is under raw/. */
    async requestOf(messageId: string): Promise<Record<string, unknown> | null> {
      try {
        const { body } = await (await files()).get({ workspaceId, key: requestKeyOf(messageId) });
        return JSON.parse(await text(body));
      } catch {
        return null;
      }
    },
    /** The touch contacts holds for the person. */
    touchOf: async (personId: string) =>
      (await app().person.findUniqueOrThrow({ where: { id: personId } })).lastTouchAt,
  };
}

/** The LinkedIn fake: its calls, recorded. */
export const linkedinFake = async (): Promise<LinkedinFake> =>
  (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
