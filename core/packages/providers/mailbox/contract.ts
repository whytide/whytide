// The mailbox port's contract (README.md "The contract suite"): what every adapter does, run with a
// MailboxWorld, the adapter's side: a connection to its mailbox for each case, a recipient the
// tester owns, the seconds to wait before findSent and, on the fake only, the helpers that play what
// a live mailbox cannot be made to receive. A live run sends one message, to the world's recipient,
// finds it by its Message-ID after the settle time and reads back its own thread; an invented thread
// ref is mailbox_not_found. The cases with a reply, a bounce, a complaint, an unsubscribe mail, a
// personal thread, a scope, a revoke or an injected code skip without the fake.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { isAppError } from "@whytide/platform";
import type { PortErrorCode, PortInstance } from "../_pattern/index.ts";
import type { ContractCases } from "../testing/index.ts";
import type { MailboxFake } from "./fake/index.ts";
import { codeChallengeFor, newCodeVerifier } from "./pkce.ts";
import { type MailboxEvent, type MailboxMatch, mailboxPort, messageIdFor } from "./port.ts";

type Mailbox = PortInstance<typeof mailboxPort>;
/** A connected mailbox: its own address, in lower case, and a fresh grant's tokens. */
export type MailboxConnection = {
  readonly address: string;
  readonly accessToken: string;
  readonly refreshToken: string;
};
export type MailboxWorld = {
  /** A connection for one case: the fake's consent (connectByConsent), a live world's own grant. */
  readonly connect: (mailbox: Mailbox) => Promise<MailboxConnection>;
  /** Where the send case writes: a mailbox of the tester's own, never a lead's. */
  readonly recipient: string;
  /** The seconds the send case waits before findSent: MAILBOX_FIND_SETTLE_SECONDS on a live adapter. */
  readonly settleSeconds: number;
  /** The fake's helpers; without them the cases that play mail skip. */
  readonly fake?: MailboxFake;
};

/** Where every case's consent returns. */
export const REDIRECT_URI = "https://app.whytide.test/api/email/oauth/callback";
const STATE = "contract-state-0001";
/** How far a provider's clock may sit from ours, for the time a send answers. */
const SKEW_MS = 60_000;
const UNSUBSCRIBE = "unsubscribe-contract-";
const NO_MATCH: MailboxMatch = { threadRefs: [], messageIds: [] };

/** A raw message as the platform's builder makes one: CRLF, one To, the Message-ID given; `headers` are added. */
export function rawMessage(message: {
  from: string;
  to: string;
  messageId: string;
  subject?: string;
  text?: string;
  headers?: readonly string[];
}): string {
  const { subject = "A contract message", text = "Hello from the contract suite." } = message;
  return [
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${message.messageId}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    ...(message.headers ?? []),
    "",
    text,
  ].join("\r\n");
}

/** A consent on an adapter whose consent URL lands on the callback at once, the fake's: exchangeCode's answer. */
export async function consentOf(mailbox: Mailbox) {
  const codeVerifier = newCodeVerifier();
  const codeChallenge = codeChallengeFor(codeVerifier);
  const auth = { redirectUri: REDIRECT_URI, state: STATE, codeChallenge };
  const callback = new URL((await mailbox.createAuthUrl(auth)).url);
  assert.equal(`${callback.origin}${callback.pathname}`, REDIRECT_URI, "on the callback");
  assert.equal(callback.searchParams.get("state"), STATE);
  const code = callback.searchParams.get("code");
  assert.ok(code, "a code on the callback");
  return mailbox.exchangeCode({ code, redirectUri: REDIRECT_URI, codeVerifier });
}

/** A connection by consentOf, whose grant shows its address. */
export async function connectByConsent(mailbox: Mailbox): Promise<MailboxConnection> {
  const { address, accessToken, refreshToken } = await consentOf(mailbox);
  assert.ok(address, "the grant shows its address");
  return { address, accessToken, refreshToken };
}

export function mailboxCases(world: MailboxWorld): ContractCases<typeof mailboxPort> {
  /** A case's connection, and its calls in short. */
  const open = async (mailbox: Mailbox, given?: MailboxConnection) => {
    const connection = given ?? (await world.connect(mailbox));
    const { address, accessToken } = connection;
    return {
      ...connection,
      /** One platform message to the world's recipient, under a new step key. */
      send: async () => {
        const idempotencyKey = `contract-${randomUUID()}`;
        const messageId = messageIdFor({ idempotencyKey, domain: address.split("@")[1] ?? "" });
        const raw = rawMessage({ from: address, to: world.recipient, messageId });
        const sent = await mailbox.sendMessage({ accessToken, raw, messageId, idempotencyKey });
        return { ...sent, messageId, threadRef: sent.threadRef ?? "" };
      },
      find: (messageId: string) => mailbox.findSent({ accessToken, messageId }),
      list: (cursor: string | null, match = NO_MATCH, limit = 20) =>
        mailbox.listNewMessages({ accessToken, address, cursor, match, limit }),
      read: (threadRef: string, limit = 10) =>
        mailbox.readThread({ accessToken, address, threadRef, limit }),
    };
  };
  /** The fake's helpers, or the case skips. */
  const fakeOf = (t: TestContext): MailboxFake | undefined => {
    if (world.fake === undefined) t.skip("needs the fake's helpers");
    return world.fake;
  };
  return {
    "createAuthUrl answers a URL that carries the state": async (mailbox) => {
      const codeChallenge = codeChallengeFor(newCodeVerifier());
      const { url } = await mailbox.createAuthUrl({
        redirectUri: REDIRECT_URI,
        state: STATE,
        codeChallenge,
      });
      assert.equal(new URL(url).searchParams.get("state"), STATE);
    },
    "refreshAccess answers an access token that reads, with a later expiry": async (mailbox) => {
      const connection = await world.connect(mailbox);
      const fresh = await mailbox.refreshAccess({ refreshToken: connection.refreshToken });
      assert.ok(fresh.accessExpiresAt.getTime() > Date.now());
      const session = await open(mailbox, { ...connection, accessToken: fresh.accessToken });
      assert.deepEqual((await session.list(null)).events, []);
    },
    "one send, found by its Message-ID after the settle time, its own thread read back with its sent event":
      async (mailbox) => {
        const session = await open(mailbox);
        const sent = await session.send();
        assert.ok(Math.abs(sent.sentAt.getTime() - Date.now()) < SKEW_MS, "sentAt is now");
        await sleep(world.settleSeconds * 1000);
        const found = await session.find(sent.messageId);
        assert.ok(found.found, "found after the settle time");
        const { events } = await session.read(found.threadRef);
        const own = events.filter(
          (event) => event.kind === "sent" && event.messageId === sent.messageId,
        );
        assert.equal(own.length, 1);
      },
    "an invented thread ref is mailbox_not_found, with nothing of it returned": async (mailbox) => {
      const session = await open(mailbox);
      await assert.rejects(session.read("contract-no-such-thread"), failsWith("mailbox_not_found"));
    },
    "a null cursor answers the current cursor and no event, though the mailbox holds older mail; then only what came after":
      async (mailbox, t) => {
        const fake = fakeOf(t);
        if (!fake) return;
        const session = await open(mailbox);
        const { messageId, threadRef } = await session.send();
        fake.playReply({ inReplyTo: messageId });
        const match = { threadRefs: [threadRef], messageIds: [messageId] };
        const first = await session.list(null, match);
        assert.deepEqual([first.events, first.more], [[], false]);
        const after = fake.playReply({ inReplyTo: messageId });
        const next = await session.list(first.cursor, match);
        assert.deepEqual(next.events.map(refOf), [after.messageRef]);
        assert.deepEqual((await session.list(next.cursor, match)).events, []);
      },
    "the five kinds for matched mail, and nothing for a personal mail, a newsletter, a thread typed by hand or a report naming another Message-ID":
      async (mailbox, t) => {
        const fake = fakeOf(t);
        if (!fake) return;
        const session = await open(mailbox);
        const { messageId, threadRef } = await session.send();
        const ids = { threadRefs: [threadRef], messageIds: [messageId] };
        const match = { ...ids, unsubscribeSubjectPrefix: UNSUBSCRIBE };
        const { cursor } = await session.list(null, match);
        const other = messageIdFor({ idempotencyKey: "contract-other", domain: "example.test" });
        fake.playPersonal();
        fake.playPersonal({ from: "news@shop.example", subject: "Offers" });
        fake.playSent();
        fake.playBounce({ originalMessageId: other });
        fake.playComplaint({ originalMessageId: other });
        const played = [
          fake.playReply({ inReplyTo: messageId, text: "Tell me more." }),
          fake.playSent({ threadRef, text: "Typed in the thread by hand." }),
          fake.playBounce({ originalMessageId: messageId }),
          fake.playComplaint({ originalMessageId: messageId }),
          fake.playUnsubscribe({ subject: `${UNSUBSCRIBE}0001` }),
        ].map((message) => message.messageRef);
        const { events, more } = await session.list(cursor, match);
        assert.deepEqual([events.map(refOf), more], [played, false]);
        assert.deepEqual(events.map(summaryOf), [
          ["reply", messageId, world.recipient.toLowerCase(), "Tell me more."],
          ["sent", threadRef, "Typed in the thread by hand."],
          ["bounce", messageId, true, "5.1.1"],
          ["complaint", messageId, "abuse"],
          ["unsubscribe_request", `${UNSUBSCRIBE}0001`],
        ]);
      },
    "readThread answers the newest limit messages in date order, more when older ones were left out; a personal thread is mailbox_not_found":
      async (mailbox, t) => {
        const fake = fakeOf(t);
        if (!fake) return;
        const session = await open(mailbox);
        const { messageId, threadRef, messageRef } = await session.send();
        const later = [
          fake.playReply({ inReplyTo: messageId }),
          fake.playSent({ threadRef }),
          fake.playBounce({ originalMessageId: messageId, status: "4.2.2" }),
        ].map((message) => message.messageRef);
        const all = await session.read(threadRef);
        assert.deepEqual([all.events.map(refOf), all.more], [[messageRef, ...later], false]);
        const kinds = all.events.map((event) => event.kind);
        assert.deepEqual(kinds, ["sent", "reply", "sent", "bounce"]);
        const newest = await session.read(threadRef, 2);
        assert.deepEqual([newest.events.map(refOf), newest.more], [later.slice(1), true]);
        const personal = fake.playPersonal();
        await assert.rejects(session.read(personal.threadRef), failsWith("mailbox_not_found"));
      },
    "a consent without reading grants send only: a send works, a read is mailbox_scope_missing":
      async (mailbox, t) => {
        const fake = fakeOf(t);
        if (!fake) return;
        fake.consentNext({ scopes: ["send"] });
        const { address, accessToken, refreshToken, scopes } = await consentOf(mailbox);
        assert.deepEqual(scopes, ["send"]);
        const session = await open(mailbox, { address: address ?? "", accessToken, refreshToken });
        const { messageId } = await session.send();
        await assert.rejects(session.find(messageId), failsWith("mailbox_scope_missing"));
      },
    "a send that fails after it went out is findable; findSent may miss it once within the settle time":
      async (mailbox, t) => {
        const fake = fakeOf(t);
        if (!fake) return;
        const session = await open(mailbox);
        fake.failAfterSendNext("mailbox_provider_error", { status: 503 });
        await assert.rejects(session.send(), failsWith("mailbox_provider_error"));
        const call = fake.recordedCalls.findLast((recorded) => recorded.method === "sendMessage");
        const { messageId } = call?.input as { messageId: string };
        assert.equal((await session.find(messageId)).found, true);
        fake.findMissesNext();
        assert.deepEqual(await session.find(messageId), { found: false });
        assert.equal((await session.find(messageId)).found, true);
      },
    "revokeAccess, or the person's revoke, ends the grant: every later call is mailbox_token_revoked":
      async (mailbox, t) => {
        const fake = fakeOf(t);
        if (!fake) return;
        const someId = messageIdFor({ idempotencyKey: "contract-revoked", domain: "example.test" });
        const revokes = [
          (refreshToken: string) => mailbox.revokeAccess({ refreshToken }),
          async () => fake.revoke(),
        ];
        for (const revoke of revokes) {
          const session = await open(mailbox);
          const { refreshToken } = session;
          await revoke(refreshToken);
          const calls = [
            () => mailbox.refreshAccess({ refreshToken }),
            () => mailbox.revokeAccess({ refreshToken }),
            session.send,
            () => session.find(someId),
            () => session.list(null),
            () => session.read("contract-thread"),
          ];
          for (const call of calls)
            await assert.rejects(call(), failsWith("mailbox_token_revoked"));
        }
      },
    "each code reaches the caller as itself: injected, an unknown access token, a cursor the provider does not know":
      async (mailbox, t) => {
        const fake = fakeOf(t);
        if (!fake) return;
        const session = await open(mailbox);
        for (const code of Object.keys(mailboxPort.errors) as PortErrorCode<typeof mailboxPort>[]) {
          fake.failNext(code);
          await assert.rejects(session.list(null), (error: unknown) => {
            assert.ok(isAppError(error) && error.code === code, `${code}: ${error}`);
            if (code === "mailbox_rate_limited") assert.equal(error.details?.retryAfterSec, 60);
            return true;
          });
        }
        const stranger = await open(mailbox, {
          ...session,
          accessToken: "an-access-token-never-given",
        });
        await assert.rejects(stranger.list(null), failsWith("mailbox_access_expired"));
        const unknown = Buffer.from("no-such-cursor").toString("base64url");
        await assert.rejects(session.list(unknown), failsWith("mailbox_cursor_invalid"));
      },
  };
}

const refOf = (event: MailboxEvent) => event.messageRef;

/** What a case checks of an event, beside its refs. */
function summaryOf(event: MailboxEvent): unknown[] {
  if (event.kind === "reply") return [event.kind, event.inReplyTo, event.fromAddress, event.text];
  if (event.kind === "sent") return [event.kind, event.threadRef, event.text];
  if (event.kind === "bounce")
    return [event.kind, event.originalMessageId, event.permanent, event.status];
  if (event.kind === "complaint") return [event.kind, event.originalMessageId, event.feedbackType];
  return [event.kind, event.subject];
}

/** The rejection is the port's code. */
const failsWith = (code: string) => (error: unknown) => {
  assert.ok(isAppError(error) && error.code === code, `expected ${code}: ${error}`);
  return true;
};
