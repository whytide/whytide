// A safety case of beta-p0-010 (briefs RB-1.2.4; linkedin/README.md "The fake"): the LinkedIn fake
// ignores the step's idempotency key, as Unipile does, and records every call, a repeat with the same
// key included, so that a caller that sends twice shows two recorded calls. The one-send guarantee
// never rests on the adapter: it rests on the caller's reservation and its check before a retry
// (beta-p1-030, beta-p1-050). Here a second sendMessage with one key is a second message in the chat,
// and a second sendInvite with one key a second call, refused as already invited.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { isAppError } from "@whytide/platform";
import { linkedinFake } from "../../linkedin/fake/index.ts";
import { linkedinPort } from "../../linkedin/port.ts";
import { getAdapter } from "../../registry.ts";

const ACCOUNT = "fake-account-safety";
const MEMBER = "fake-member-safety";
const KEY = "step-key-0001";
const linkedin = await getAdapter(linkedinPort, "fake");
const callsOf = (method: string) =>
  linkedinFake.recordedCalls.filter((call) => call.method === method);

beforeEach(() => {
  linkedinFake.reset();
  linkedinFake.emitWebhook("account.connected", ACCOUNT);
});

test("two sendMessage calls with one idempotencyKey record two calls and leave two messages in the chat", async () => {
  linkedinFake.seedRelation(ACCOUNT, MEMBER);
  const since = new Date(Date.now() - 1000);
  const send = {
    providerAccountRef: ACCOUNT,
    memberRef: MEMBER,
    text: "Thanks for connecting",
    idempotencyKey: KEY,
  };
  const first = await linkedin.sendMessage(send);
  const second = await linkedin.sendMessage(send);
  assert.deepEqual(callsOf("sendMessage"), [
    { method: "sendMessage", input: send },
    { method: "sendMessage", input: send },
  ]);
  assert.notEqual(second.messageRef, first.messageRef, "a second message, not the first again");
  assert.equal(second.chatRef, first.chatRef);
  const read = { providerAccountRef: ACCOUNT, memberRef: MEMBER, since };
  const { messages } = await linkedin.listRecentMessages(read);
  assert.deepEqual(
    messages.map(({ messageRef, chatRef, fromAccount }) => [messageRef, chatRef, fromAccount]),
    [
      [first.messageRef, first.chatRef, true],
      [second.messageRef, first.chatRef, true],
    ],
  );
});

test("two sendInvite calls with one idempotencyKey record two calls; the second is linkedin_send_refused, already invited", async () => {
  const send = { providerAccountRef: ACCOUNT, memberRef: MEMBER, idempotencyKey: KEY };
  const { invitationRef } = await linkedin.sendInvite(send);
  await assert.rejects(
    linkedin.sendInvite(send),
    (error: unknown) => isAppError(error) && error.code === "linkedin_send_refused",
  );
  assert.deepEqual(callsOf("sendInvite"), [
    { method: "sendInvite", input: send },
    { method: "sendInvite", input: send },
  ]);
  const { invites, nextCursor } = await linkedin.listPendingInvites({
    providerAccountRef: ACCOUNT,
  });
  assert.deepEqual(
    invites.map((invite) => [invite.invitationRef, invite.memberRef]),
    [[invitationRef, MEMBER]],
  );
  assert.equal(nextCursor, null);
});
