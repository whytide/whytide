// A reservation is no licence to send (beta-p1-050; core/modules/linkedin docs/flows.md "The send
// activities"): the switches and the account are read again just before the call. Sending closed, a
// kill switch, the invites' pause (invites only), an account not connected, or a retry_at ahead, set
// between the reservation and the call, stop it on the first attempt and on a retry, with no send
// recorded; the first attempt releases the slot and logs the code. And no call is made under a
// reservation released, swept, missing, another step's, or with less than SEND_CALL_MARGIN_MS left.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  db,
  later,
  linkedin,
  methods,
  reservationOf,
  reserveSend,
  rowsOf,
  type Sender,
  sender,
  sends,
  settle,
  THURSDAY,
  useSendTests,
} from "../fixtures/linkedin-send.ts";

useSendTests();
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

type Case = {
  readonly name: string;
  readonly set: (account: Sender) => Promise<unknown>;
  readonly refused: string;
  /** Reads go on: the check before a retry is granted, then the re-read stops the send. */
  readonly sendsOnly?: boolean;
};
const account = (data: object) => (a: Sender) =>
  db().senderAccount.update({ where: { id: a.accountId }, data });
const CASES: readonly Case[] = [
  {
    name: "sending closed",
    set: () => linkedin.setPlatformControls({ sendingOpen: false }),
    refused: "sending_closed",
    sendsOnly: true,
  },
  {
    name: "invites paused",
    set: () => linkedin.setPlatformControls({ invitesPaused: true }),
    refused: "invites_paused",
    sendsOnly: true,
  },
  {
    name: "the platform stopped",
    set: () => linkedin.setPlatformControls({ stopped: true }),
    refused: "platform_stopped",
  },
  {
    name: "the workspace stopped",
    set: (a) => linkedin.setWorkspaceStopped(a.workspaceId, "tester"),
    refused: "workspace_stopped",
  },
  {
    name: "the account paused",
    set: (a) => linkedin.setAccountPaused(a.accountId, "operator"),
    refused: "account_stopped",
  },
  {
    name: "the account not connected",
    set: account({ status: "error" }),
    refused: "linkedin_account_disconnected",
  },
  {
    name: "a retry_at ahead",
    set: account({ retryAt: new Date(THURSDAY.getTime() + HOUR_MS) }),
    refused: "rate_limited",
  },
];

for (const { name, set, refused, sendsOnly = false } of CASES) {
  test(`${name}, set between the reservation and the call: no send, on the first attempt (the slot released, the code logged) and on a retry`, async () => {
    const a = await sender();
    const first = await a.step("invite");
    const retried = await a.step("invite");
    await set(a);
    const answer = await a.call("linkedin_send_invite", first.input());
    const retryAt = refused === "rate_limited" ? new Date(THURSDAY.getTime() + HOUR_MS) : null;
    assert.deepEqual(answer, { refused, retryAt: retryAt?.toISOString() ?? null });
    assert.equal((await reservationOf(first.reservationId)).status, "released");
    assert.deepEqual(await rowsOf(first.stepExecutionId), [`invite:${refused}`]);

    const again = (await a.call("linkedin_send_invite", retried.input(2))) as { refused: string };
    assert.equal(again.refused, refused);
    assert.deepEqual(sends(), []);
    // A read the switch stops leaves the slot to the check; a send-only gate releases it.
    const status = (await reservationOf(retried.reservationId)).status;
    assert.equal(status, sendsOnly ? "released" : "reserved");
    assert.deepEqual(methods(), sendsOnly ? ["getRelation"] : []);
  });
}

test("sending closed: no reservation is granted; invites paused stop invites only", async () => {
  const a = await sender();
  await linkedin.setPlatformControls({ invitesPaused: true });
  const message = await a.step("message");
  assert.deepEqual(await a.call("linkedin_send_message", message.input()), {
    sent: true,
    stepExecutionId: message.stepExecutionId,
  });
  await linkedin.setPlatformControls({ sendingOpen: false });
  const input = {
    accountId: a.accountId,
    actionType: "message" as const,
    idempotencyKey: "closed",
  };
  const reservation = await a.run(() => reserveSend(input));
  assert.deepEqual(reservation, { refused: "sending_closed", retryAt: null });
});

test("no call under a reservation released, swept, missing or another step's, nor with less than SEND_CALL_MARGIN_MS left on its hold, which is released; two minutes left is enough", async () => {
  const a = await sender();
  const released = await a.step("invite");
  await a.run(() => settle.releaseSend(released.reservationId));
  const swept = await a.step("invite");
  const missing = await a.step("invite");
  const other = await a.step("invite");
  const short = await a.step("invite");
  const enough = await a.step("invite");
  const notOpen = { refused: "reservation_not_open", retryAt: null };
  const call = (input: object) => a.call("linkedin_send_invite", input);
  assert.deepEqual(await call(released.input()), notOpen);
  assert.deepEqual(await call(missing.input(1, "sqr_00000000000000000000000000")), notOpen);
  assert.deepEqual(await call(other.input(1, enough.reservationId)), notOpen);
  assert.equal((await reservationOf(enough.reservationId)).status, "reserved", "not the step's");

  later(2 * HOUR_MS - 2 * MINUTE_MS);
  assert.deepEqual(await call(enough.input()), {
    sent: true,
    stepExecutionId: enough.stepExecutionId,
  });
  later(MINUTE_MS);
  assert.deepEqual(await call(short.input()), notOpen);
  assert.equal((await reservationOf(short.reservationId)).status, "released");

  later(2 * HOUR_MS);
  await a.reserve("step-sweeping", "invite");
  assert.equal((await reservationOf(swept.reservationId)).status, "expired");
  assert.deepEqual(await call(swept.input()), notOpen);
  assert.equal(sends().length, 1, "the one with two minutes left");
});
