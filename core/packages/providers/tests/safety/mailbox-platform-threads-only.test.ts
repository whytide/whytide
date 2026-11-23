// A safety case of gamma-p0-010 (F11 §4.1: the platform reads only the threads it started, and
// personal email is never processed; briefs RB-12.1.1; mailbox/README.md "The match", "What the port
// will never have"). Nothing outside the match leaves the fake: listNewMessages answers no event for
// a personal message, a newsletter, a thread the platform did not start, one the member started by
// hand, or a report naming a Message-ID outside the match, and nothing of them is in its answer;
// readThread on each of those threads, and on an unknown ref, is mailbox_not_found and returns
// nothing of it. And the never list: exactly the eight methods, no name holding search, delete,
// trash, move, label, folder or forward, in the types (tsc -b, which test:safety runs first, fails on
// such a method) and at run time; an adapter that adds one fails the shape check.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isAppError } from "@whytide/platform";
import { bindPort } from "../../_pattern/index.ts";
import { connectByConsent, rawMessage } from "../../mailbox/contract.ts";
import { mailboxFake } from "../../mailbox/fake/index.ts";
import { mailboxPort, messageIdFor } from "../../mailbox/port.ts";
import { getAdapter } from "../../registry.ts";

const mailbox = await getAdapter(mailboxPort, "fake");
const EIGHT = [
  "createAuthUrl",
  "exchangeCode",
  "refreshAccess",
  "revokeAccess",
  "sendMessage",
  "findSent",
  "listNewMessages",
  "readThread",
];
const NEVER = ["search", "delete", "trash", "move", "label", "folder", "forward"] as const;
type NeverWord = (typeof NEVER)[number];
/** True when no name among N, lower-cased, holds a never-list word. */
type Clean<N> = [Extract<Lowercase<N & string>, `${string}${NeverWord}${string}`>] extends [never]
  ? true
  : false;
type Methods = keyof typeof mailboxPort.methods;
// The port's methods: tsc fails on this line the day one holds a never-list word.
const portClean: Clean<Methods> = true;
// The check bites on every word, inside a camelCase name too.
type Missed = {
  [W in NeverWord]: Clean<`mail${Capitalize<W>}Now`> extends true ? W : never;
}[NeverWord];
const everyWordCaught: [Missed] extends [never] ? true : false = true;
// @ts-expect-error a port with a searchMessages method fails the check
const withSearch: Clean<Methods | "searchMessages"> = true;

const FRIEND = "a.friend@personal.example";
const NEWS = "news@shop.example";
const PERSONAL = ["Dinner on Friday?", "Shall we meet at eight?", "Yes, eight works.", "My notes"];

test("nothing outside the match leaves the fake: no event and no trace of personal mail; readThread refuses every thread the platform did not start", async () => {
  mailboxFake.reset();
  const { address, accessToken } = await connectByConsent(mailbox);
  const messageId = messageIdFor({ idempotencyKey: "step-key-threads", domain: "example.test" });
  const raw = rawMessage({ from: address, to: "lead@example.test", messageId });
  const platform = await mailbox.sendMessage({
    accessToken,
    raw,
    messageId,
    idempotencyKey: "step-key-threads",
  });
  const { cursor } = await listed(accessToken, address, null, []);
  const [subject, text, answer, notes] = PERSONAL as [string, string, string, string];
  const personal = mailboxFake.playPersonal({ from: FRIEND, subject, text });
  const newsletter = mailboxFake.playPersonal({ from: NEWS, subject: "Offers", text: "Sale" });
  const typed = mailboxFake.playSent({ threadRef: personal.threadRef, text: answer });
  const friendAgain = mailboxFake.playReply({ inReplyTo: typed.messageId, from: FRIEND, text });
  const byHand = mailboxFake.playSent({ subject: notes, text: notes });
  const otherSend = messageIdFor({ idempotencyKey: "another-step", domain: "example.test" });
  const bounced = mailboxFake.playBounce({ originalMessageId: otherSend });
  const personalBounce = mailboxFake.playBounce({ originalMessageId: typed.messageId });
  const complaint = mailboxFake.playComplaint({ originalMessageId: typed.messageId });
  const reply = mailboxFake.playReply({ inReplyTo: messageId });
  const threadRef = platform.threadRef as string;
  const answered = await listed(accessToken, address, cursor, [threadRef], [messageId]);
  assert.deepEqual(
    answered.events.map((event) => [event.kind, event.messageRef]),
    [["reply", reply.messageRef]],
    "the matched reply, and nothing else",
  );
  const outside = [personal, newsletter, typed, friendAgain, byHand, bounced, personalBounce];
  const traces = [FRIEND, NEWS, ...PERSONAL, ...[...outside, complaint].flatMap(refsOf)];
  const said = JSON.stringify(answered);
  assert.deepEqual(
    traces.filter((value) => said.includes(value)),
    [],
  );
  const refusedThreads = [...outside, complaint].map((played) => played.threadRef);
  for (const ref of [...new Set(refusedThreads), "fake-thread-unknown"]) {
    await assert.rejects(
      mailbox.readThread({ accessToken, address, threadRef: ref, limit: 10 }),
      (error: unknown) => {
        assert.ok(isAppError(error) && error.code === "mailbox_not_found", String(error));
        const refusal = JSON.stringify([error.message, error.details]);
        assert.deepEqual(
          traces.filter((value) => refusal.includes(value)),
          [],
        );
        return true;
      },
    );
  }
  const thread = await mailbox.readThread({ accessToken, address, threadRef, limit: 10 });
  assert.deepEqual(
    thread.events.map((event) => event.kind),
    ["sent", "reply"],
  );
});

test("exactly the eight methods, none on the never list, in the types and at run time, on the port and the bound fake", async () => {
  assert.deepEqual([portClean, everyWordCaught, withSearch], [true, true, true]);
  assert.deepEqual(Object.keys(mailboxPort.methods), EIGHT);
  const onNeverList = (names: readonly string[]) =>
    names.filter((name) => NEVER.some((word) => name.toLowerCase().includes(word)));
  assert.deepEqual(onNeverList(Object.keys(mailboxPort.methods)), []);
  // The fake's controls and helpers too: nothing a test can call there is on the list.
  assert.deepEqual(onNeverList(Object.keys(mailbox)), []);
});

test("an adapter adding a never-list method, or lacking one of the eight, fails the port's shape check", () => {
  const call = async () => {
    throw new Error("never called");
  };
  const adapterOf = (names: readonly string[]) =>
    Object.fromEntries(names.map((name) => [name, call]));
  const mismatch = (names: readonly string[], expected: object) =>
    assert.throws(
      () => bindPort(mailboxPort, adapterOf(names) as never, { adapter: "never-list" }),
      (error: unknown) => {
        assert.ok(isAppError(error) && error.code === "port_shape_mismatch");
        const { missing, extra } = error.details ?? {};
        assert.deepEqual({ missing, extra }, expected);
        return true;
      },
    );
  mismatch([...EIGHT, "searchMessages", "moveToTrash", "forwardMessage"], {
    missing: [],
    extra: ["searchMessages", "moveToTrash", "forwardMessage"],
  });
  mismatch(
    EIGHT.filter((name) => name !== "readThread"),
    { missing: ["readThread"], extra: [] },
  );
});

/** listNewMessages over the platform's thread and Message-IDs, and the unsubscribe mail's prefix. */
function listed(
  accessToken: string,
  address: string,
  cursor: string | null,
  threadRefs: string[],
  messageIds: string[] = [],
) {
  const match = { threadRefs, messageIds, unsubscribeSubjectPrefix: "unsubscribe-" };
  return mailbox.listNewMessages({ accessToken, address, cursor, match, limit: 100 });
}

/** A played message's refs and Message-ID: none may leave the fake. */
const refsOf = (played: { messageRef: string; threadRef: string; messageId: string }) => [
  played.messageRef,
  played.threadRef,
  played.messageId,
];
