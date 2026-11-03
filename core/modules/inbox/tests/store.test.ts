// The store's run (domain/store/; README.md "The store"), on a schema of the worktree's database:
// the thread made once per chat with the account's owner, its last_message_at moved forward only; a
// repeat of a message stored once with one event; no file, the hold alone; a reply without an
// opt-out phrase holds and does not suppress; a person erased since the reply, nothing written back
// and the file deleted (the activity's body, on the files fake). The safety case is
// tests/safety/reply-hold.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { erasePerson as eraseEnrollments } from "@whytide/campaigns";
import { erasePerson } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import type { MessageFile } from "@whytide/linkedin";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { isAppError } from "@whytide/platform";
import { filesPort, getAdapter } from "@whytide/providers";
import { storeInbound } from "../domain/store/store.ts";
import { type StoreInput, storeMessage } from "../workflows/index.ts";
import { fixture, HELD, replyFile } from "./fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
const f = fixture("wsp_inbox_store");
const store = (
  personId: string,
  senderAccountId: string,
  file: MessageFile | null,
  now = new Date(),
) => f.run(() => storeInbound({ personId, senderAccountId, file, now }));
const replies = async () =>
  (await f.eventNames()).filter((name) => name === "inbox.reply_received");

test("a reply makes the chat's thread, with the account's owner, and stores the message in it", async () => {
  const { id: senderAccountId } = await f.account();
  const personId = await f.enrolled(senderAccountId, "store-first");
  const sentAt = new Date("2026-10-29T09:00:00.000Z");
  const now = new Date("2026-10-29T09:00:05.000Z");
  const file = replyFile("Thanks, next week works.", { sentAt: sentAt.toISOString() });

  const result = await store(personId, senderAccountId, file, now);

  assert.equal(result.stored, true);
  assert.equal(result.optOut, false);
  assert.deepEqual(await f.stepsOf(personId), HELD);
  assert.equal(await f.leadOf(personId), "replied");
  assert.deepEqual(await f.optOuts(), []);
  const thread = await asRole("app").thread.findFirstOrThrow({ where: { personId } });
  assert.deepEqual(
    { ...thread, id: undefined, createdAt: undefined, updatedAt: undefined },
    {
      ...{ id: undefined, workspaceId: "wsp_inbox_store", channel: "linkedin", senderAccountId },
      ...{ ownerUserId: "usr_inbox_owner", personId, providerThreadRef: file.chatRef },
      ...{ lastMessageAt: sentAt, createdAt: undefined, updatedAt: undefined },
    },
  );
  const message = await asRole("app").message.findUniqueOrThrow({
    where: { id: result.messageId },
  });
  assert.equal(message.threadId, thread.id);
  assert.equal(message.direction, "in");
  assert.equal(message.sentBy, null);
  assert.equal(message.body, file.text);
  assert.equal(message.providerMessageRef, file.messageRef);
  assert.deepEqual([message.sentAt, message.receivedAt], [sentAt, now]);
});

test("the chat keeps one thread, its last_message_at moved forward only", async () => {
  const { id: senderAccountId } = await f.account();
  const personId = await f.enrolled(senderAccountId, "store-chat");
  const chatRef = `chat-${personId}`;
  const at = (iso: string) => replyFile("Sure.", { chatRef, sentAt: iso });

  await store(personId, senderAccountId, at("2026-10-29T10:00:00.000Z"));
  await store(personId, senderAccountId, at("2026-10-29T12:00:00.000Z"));
  // An older message, delivered late: stored, the thread's time kept.
  await store(personId, senderAccountId, at("2026-10-29T11:00:00.000Z"));

  const threads = await asRole("app").thread.findMany({ where: { personId } });
  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0]?.lastMessageAt, new Date("2026-10-29T12:00:00.000Z"));
  assert.equal(await asRole("app").message.count({ where: { personId } }), 3);
});

test("a repeat of a message is stored once, with one inbox.reply_received", async () => {
  const { id: senderAccountId } = await f.account();
  const personId = await f.enrolled(senderAccountId, "store-repeat");
  const file = replyFile("Thanks, next week works.");
  const before = (await replies()).length;

  const first = await store(personId, senderAccountId, file);
  const again = await store(personId, senderAccountId, file);

  assert.equal(first.stored, true);
  assert.deepEqual(again, { stored: false, held: true, optOut: false });
  assert.equal(await asRole("app").message.count({ where: { personId } }), 1);
  assert.equal((await replies()).length, before + 1);
});

test("without the file, the person's steps are held and nothing is stored", async () => {
  const { id: senderAccountId } = await f.account();
  const personId = await f.enrolled(senderAccountId, "store-no-file");
  const before = (await replies()).length;

  assert.deepEqual(await store(personId, senderAccountId, null), {
    ...{ stored: false, held: true, optOut: false },
  });

  assert.deepEqual(await f.stepsOf(personId), HELD);
  assert.equal(await f.leadOf(personId), "replied");
  assert.equal(await asRole("app").thread.count({ where: { personId } }), 0);
  assert.equal(await asRole("app").message.count({ where: { personId } }), 0);
  assert.equal((await replies()).length, before);
});

test("a reply of a person erased since writes nothing back, publishes nothing and loses its file", async () => {
  // A workspace id the files port takes, so the activity's body runs on the files fake.
  const workspaceId = "wsp_inboxerased";
  const g = fixture(workspaceId);
  const { id: senderAccountId } = await g.account();
  const files = await getAdapter(filesPort, "fake");
  for (const [slug, text] of [
    ["store-erased", "Thanks, next week works."],
    ["store-erased-stop", "Please remove me."],
  ] as const) {
    const personId = await g.enrolled(senderAccountId, slug);
    // The erasure as privacy's script runs it, contacts last, after the reply's event went out.
    await g.run(async () => {
      await eraseEnrollments(personId);
      await erasePerson(personId);
    });
    const put = { workspaceId, key: `raw/linkedin/messages/${slug}.json` };
    const body = JSON.stringify(replyFile(text));
    const { key } = await files.put({ ...put, body, contentType: "application/json" });
    const before = { events: await g.eventNames(), optOuts: await g.optOuts() };
    const fileKey = key;
    const input: StoreInput = { workspaceId, senderAccountId, personId, direction: "in", fileKey };

    const result = await storeMessage({ workspaceId, tenant: g.run }, input);

    assert.deepEqual(result, { stored: false, held: true, optOut: false }, text);
    assert.deepEqual([await g.threads(), await g.messages()], [[], []], text);
    assert.deepEqual({ events: await g.eventNames(), optOuts: await g.optOuts() }, before, text);
    await assert.rejects(files.get({ workspaceId, key }), (error) => {
      return isAppError(error) && error.code === "files_not_found";
    });
  }
});
