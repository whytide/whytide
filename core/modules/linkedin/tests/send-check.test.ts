// The went-out decision (domain/send/went-out.ts, beta-p1-050) from the port's answers: an invite
// pending or connected, a withdrawal no longer pending, a message of the account's since the key's
// first reservation less the skew; and the reply linkedin_check_reply finds after the last send.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecentMessage } from "@whytide/providers";
import { SEND_CHECK_SKEW_MS } from "../domain/send/constants.ts";
import { messagesSince, repliedAt, wentOut } from "../domain/send/went-out.ts";

const RESERVED = new Date("2026-10-22T10:00:00Z");
const since = messagesSince(RESERVED);
const at = (offsetMs: number) => new Date(RESERVED.getTime() + offsetMs);
const message = (fromAccount: boolean, sentAt: Date, ref = "m1"): RecentMessage => ({
  messageRef: ref,
  chatRef: "chat-1",
  fromAccount,
  sentAt,
});
const relation = (connected: boolean, invitationPending: boolean) => ({
  connected,
  invitationPending,
});

test("an invite went out when the member is invited or connected, else not", () => {
  const invite = (connected: boolean, pending: boolean) =>
    wentOut({ actionType: "invite", relation: relation(connected, pending) });
  assert.deepEqual([invite(false, true), invite(true, false)], [{}, {}]);
  assert.equal(invite(false, false), null);
});

test("a withdrawal went out when no invitation is pending, accepted meanwhile included", () => {
  const withdraw = (connected: boolean, pending: boolean) =>
    wentOut({ actionType: "withdraw", relation: relation(connected, pending) });
  assert.deepEqual([withdraw(false, false), withdraw(true, false)], [{}, {}]);
  assert.equal(withdraw(false, true), null);
});

test("a message went out when the chat holds the account's own since the reservation, less the skew; the latest is kept", () => {
  assert.equal(since.getTime(), RESERVED.getTime() - SEND_CHECK_SKEW_MS);
  const check = (messages: RecentMessage[]) => wentOut({ actionType: "message", messages, since });
  const latest = message(true, at(60_000), "m3");
  const found = check([message(true, at(1_000), "m2"), latest, message(false, at(120_000))]);
  assert.deepEqual(found, { message: latest });
  assert.deepEqual(check([message(true, since, "edge")])?.message?.messageRef, "edge");
  assert.equal(check([message(true, at(-SEND_CHECK_SKEW_MS - 1))]), null, "before the skew");
  assert.equal(check([message(false, at(1_000))]), null, "the person's own");
  assert.equal(check([]), null);
});

test("a reply is the person's latest message after the last send, never the account's own or an earlier one", () => {
  const sent = at(0);
  const replies = [message(false, at(5_000)), message(false, at(9_000)), message(true, at(20_000))];
  assert.deepEqual(repliedAt(replies, sent), at(9_000));
  assert.equal(repliedAt([message(false, sent), message(true, at(1_000))], sent), null);
  assert.equal(repliedAt([], sent), null);
});
