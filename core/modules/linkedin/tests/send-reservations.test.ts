// The send reservations end to end (beta-p1-030; README.md "Read quota"), in this file's schema of
// the worktree's database, each call in a tenant run as `app`, on a clock and draws the test sets:
// the refusals in their order with their retryAt and one log row each, the note budget, the sweep
// and the settles of each type, the settles' refusals, and the readers of the send activities.
import assert from "node:assert/strict";
import test from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { newId } from "@whytide/platform";
import { logAction } from "../domain/action-log/log.ts";
import { DAY_MS } from "../domain/quota/constants.ts";
import { commitReads, releaseReads } from "../domain/quota/reservations.ts";
import { SEND_RESERVATION_MS } from "../domain/send/constants.ts";
import { findSendReservation, reservationsOfKey } from "../domain/send/readers.ts";
import { commitSend, releaseSend } from "../domain/send/settle.ts";
import { ids } from "../ids.ts";
import { useClock, useLinkedinClient, useRandom } from "../testing/index.ts";
import { granted, sender, THURSDAY } from "./fixtures/send.ts";

withTestDb();
const app = asRole("app");
useLinkedinClient(app);
let at = THURSDAY;
useClock(() => at);
useRandom(() => 0.999); // the day's limits are the targets: 5 connection requests, 10 messages
const OFFICE = { start: "08:30", end: "18:00", days: [1, 2, 3, 4, 5] };
const STEP = "sx_01JABCDEFGHJKMNPQRSTVWXYZ0";

/** An invitation with a note that went out now, as the send activity logs it. */
const sentNote = (account: Awaited<ReturnType<typeof sender>>) =>
  account.run(() =>
    logAction({
      accountId: account.id,
      kind: "invite",
      objectRef: STEP,
      count: 1,
      outcome: "ok",
      withNote: true,
    }),
  );

/** The account's log rows written by the reservations: kind, outcome and note, in order. */
const logged = async (accountId: string) =>
  (
    await app.senderActionLog.findMany({
      where: { senderAccountId: accountId },
      orderBy: [{ at: "asc" }, { id: "asc" }],
    })
  ).map(({ kind, outcome, withNote }) => [kind, outcome, withNote]);

test("the account's state first: not connected, null, for sends and reads; then retry_at, over the hours; then the hours, with the next weekday window; one log row each", async () => {
  const account = await sender("Europe/Paris", OFFICE);
  at = new Date("2026-10-22T17:00:00Z"); // Thursday 19:00 in Paris
  const retryAt = new Date("2026-10-22T18:00:00Z");
  await app.senderAccount.update({
    where: { id: account.id },
    data: { status: "disconnected", retryAt },
  });
  const disconnected = { refused: "linkedin_account_disconnected", retryAt: null };
  assert.deepEqual(await account.send("key-a", "message"), disconnected);
  assert.deepEqual(await account.read(), disconnected);
  await app.senderAccount.update({ where: { id: account.id }, data: { status: "connected" } });
  assert.deepEqual(await account.send("key-a", "message"), { refused: "rate_limited", retryAt });
  at = retryAt;
  const friday = new Date("2026-10-23T06:30:00Z"); // Friday 08:30 in Paris
  const closed = { refused: "outside_working_hours", retryAt: friday };
  assert.deepEqual(await account.send("key-a", "withdraw"), closed);
  assert.deepEqual(await logged(account.id), [
    ["message", "linkedin_account_disconnected", false],
    ["send_check", "linkedin_account_disconnected", false],
    ["message", "rate_limited", false],
    ["withdraw", "outside_working_hours", false],
  ]);
  assert.equal(await app.senderQuotaUsage.count({ where: { senderAccountId: account.id } }), 0);
});

test("then the budgets: the month's notes, the day's limit of the type, the week's 100 for an invite, the 200; each with its retryAt and one log row; an invite without a note passes the notes", async () => {
  const account = await sender();
  for (const daysAgo of [20, 10, 1]) {
    at = new Date(THURSDAY.getTime() - daysAgo * DAY_MS);
    await sentNote(account);
  }
  at = THURSDAY;
  const noteOpens = new Date(THURSDAY.getTime() + 10 * DAY_MS); // the oldest note, 30 days on
  const notes = { refused: "invite_note_budget", retryAt: noteOpens };
  assert.deepEqual(await account.send("key-n", "invite", { withNote: true }), notes);
  granted(await account.send("key-i1"));
  granted(await account.send("key-m1", "message"));
  const [day] = await account.days();
  const set = (data: Record<string, number>) =>
    app.senderQuotaUsage.update({ where: { id: day?.id }, data });

  const friday = new Date("2026-10-23T00:00:00Z");
  await set({ invitesCommitted: 4 });
  assert.deepEqual(await account.send("key-i2"), {
    refused: "invite_cap_reached",
    retryAt: friday,
  });
  assert.deepEqual(await account.send("key-n", "invite", { withNote: true }), notes);
  await set({ invitesCommitted: 0, messagesCommitted: 9 });
  const messages = { refused: "message_cap_reached", retryAt: friday };
  assert.deepEqual(await account.send("key-m2", "message"), messages);
  await set({ messagesCommitted: 0, withdrawalsCommitted: 15 });
  const withdrawals = { refused: "withdrawal_cap_reached", retryAt: friday };
  assert.deepEqual(await account.send("key-w1", "withdraw"), withdrawals);

  // 99 over the five quota days before, the sixth empty, and today's 1: room again on Saturday.
  const week = { "2026-10-17": 4, "2026-10-18": 25, "2026-10-19": 25, "2026-10-20": 25 };
  for (const [quotaDay, invitesCommitted] of Object.entries({ ...week, "2026-10-21": 20 })) {
    const id = newId(ids.sender_quota_usage);
    const row = { id, workspaceId: account.workspaceId, senderAccountId: account.id };
    await app.senderQuotaUsage.create({
      data: { ...row, quotaDay, timeZone: "UTC", invitesCommitted },
    });
  }
  const saturday = new Date("2026-10-24T00:00:00Z");
  const weekly = { refused: "weekly_invite_cap_reached", retryAt: saturday };
  assert.deepEqual(await account.send("key-i3"), weekly);
  await set({ withdrawalsCommitted: 0, readsCommitted: 198 });
  assert.deepEqual(await account.send("key-i3"), weekly);
  const actions = { refused: "daily_actions_cap_reached", retryAt: friday };
  assert.deepEqual(await account.send("key-m2", "message"), actions);

  assert.deepEqual((await logged(account.id)).slice(3), [
    ["invite", "invite_note_budget", true],
    ["invite", "reserved", false],
    ["message", "reserved", false],
    ["invite", "invite_cap_reached", false],
    ["invite", "invite_note_budget", true],
    ["message", "message_cap_reached", false],
    ["withdraw", "withdrawal_cap_reached", false],
    ["invite", "weekly_invite_cap_reached", false],
    ["invite", "weekly_invite_cap_reached", false],
    ["message", "daily_actions_cap_reached", false],
  ]);
});

test("the note budget counts the open reservations with a note too: two held and one sent fill it until the sent one is 30 days old; a released one frees its note", async () => {
  const account = await sender();
  at = new Date(THURSDAY.getTime() - 5 * DAY_MS);
  await sentNote(account);
  at = THURSDAY;
  const withNote = { withNote: true };
  granted(await account.send("key-n1", "invite", withNote));
  const held = granted(await account.send("key-n2", "invite", withNote));
  const opens = new Date(THURSDAY.getTime() + 25 * DAY_MS);
  const refused = { refused: "invite_note_budget", retryAt: opens };
  assert.deepEqual(await account.send("key-n3", "invite", withNote), refused);
  await account.release(held);
  granted(await account.send("key-n3", "invite", withNote));
});

test("the sweep frees the invite, message and withdrawal slots past their hold, and each settle moves its own type's counters", async () => {
  const account = await sender();
  at = THURSDAY;
  const invite = granted(await account.send("key-invite"));
  const message = granted(await account.send("key-message", "message"));
  granted(await account.send("key-withdraw", "withdraw"));
  granted(await account.send("key-message-2", "message"));
  await account.commit(invite);
  await account.release(message);
  const counters = async () => {
    const [day] = await account.days();
    return [
      [day?.invitesReserved, day?.invitesCommitted],
      [day?.messagesReserved, day?.messagesCommitted],
      [day?.withdrawalsReserved, day?.withdrawalsCommitted],
      [day?.readsReserved, day?.readsCommitted],
    ];
  };
  const before = [
    [0, 1],
    [1, 0],
    [1, 0],
    [0, 0],
  ];
  assert.deepEqual(await counters(), before);
  at = new Date(THURSDAY.getTime() + SEND_RESERVATION_MS);
  granted(await account.read(2));
  const after = [
    [0, 1],
    [0, 0],
    [0, 0],
    [2, 0],
  ];
  assert.deepEqual(await counters(), after);
  const statuses = await app.senderQuotaReservation.findMany({
    where: { senderAccountId: account.id, actionType: { not: "read" } },
    orderBy: { idempotencyKey: "asc" },
  });
  assert.deepEqual(
    statuses.map((row) => [row.idempotencyKey, row.status, row.committed]),
    [
      ["key-invite", "committed", 1],
      ["key-message", "released", null],
      ["key-message-2", "expired", null],
      ["key-withdraw", "expired", null],
    ],
  );
});

test("a send's settle refuses a read's reservation and a read's settle a send's, reservation_not_open; so does the release of a committed send and the settle of an unknown id", async () => {
  const account = await sender();
  at = THURSDAY;
  const read = granted(await account.read());
  const send = granted(await account.send("key-settles"));
  const notOpen = { code: "reservation_not_open" };
  await assert.rejects(account.commit(read), notOpen);
  await assert.rejects(account.release(read), notOpen);
  await assert.rejects(
    account.run(() => commitReads(send, 1)),
    notOpen,
  );
  await assert.rejects(
    account.run(() => releaseReads(send)),
    notOpen,
  );
  await account.commit(send);
  await assert.rejects(account.release(send), notOpen);
  await assert.rejects(
    account.run(() => commitSend("sqr_unknown")),
    notOpen,
  );
  await assert.rejects(
    account.run(() => releaseSend("sqr_unknown")),
    notOpen,
  );
});

test("the readers: a send reservation by id with its status, hold, type, key, note and creation, none for a read's; the reservations of one key, oldest first", async () => {
  const account = await sender();
  at = THURSDAY;
  const read = granted(await account.read());
  const first = granted(await account.send("key-read", "withdraw"));
  await account.release(first);
  const second = granted(await account.send("key-read", "withdraw"));
  const expiresAt = new Date(THURSDAY.getTime() + SEND_RESERVATION_MS);
  const row = (id: string, status: string) => ({
    id,
    senderAccountId: account.id,
    actionType: "withdraw",
    idempotencyKey: "key-read",
    status,
    expiresAt,
    withNote: false,
    createdAt: THURSDAY,
  });
  assert.deepEqual(await account.run(() => findSendReservation(second)), row(second, "reserved"));
  assert.equal(await account.run(() => findSendReservation(read)), null);
  assert.deepEqual(await account.run(() => reservationsOfKey("key-read")), [
    row(first, "released"),
    row(second, "reserved"),
  ]);
});
