// The safety cases of the send reservations (beta-p1-030; docs/security.md "Budgets"), run by
// `pnpm -F @whytide/linkedin test:safety` and not by `test`: no step takes two slots under one key,
// concurrent calls or not, and no budget is passed by concurrent calls. Twenty reservations with
// distinct keys at once; one key twice, and ten times at once; release then reserve, expiry then
// reserve; a commit twice; a late commit beside an open twin, and the partial unique index.
import assert from "node:assert/strict";
import test from "node:test";
import { createDbClient } from "@whytide/db";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import { newId } from "@whytide/platform";
import { SEND_RESERVATION_MS } from "../../domain/send/constants.ts";
import { ids } from "../../ids.ts";
import { useClock, useLinkedinClient, useRandom } from "../../testing/index.ts";
import { granted, sender, THURSDAY } from "../fixtures/send.ts";

const db = withTestDb();
const app = asRole("app");
useLinkedinClient(app);
let at = THURSDAY;
useClock(() => at);
useRandom(() => 0.999); // the day's limits are the targets: 5 connection requests, 10 messages

const counters = async (accountId: string) => {
  const [day] = await app.senderQuotaUsage.findMany({ where: { senderAccountId: accountId } });
  return [day?.invitesReserved, day?.invitesCommitted];
};
const live = (idempotencyKey: string) =>
  app.senderQuotaReservation.count({
    where: { idempotencyKey, status: { in: ["reserved", "committed"] } },
  });

test("twenty reservations with distinct keys at once, on twenty connections, against 5 connection requests left: exactly 5 granted", async () => {
  at = THURSDAY;
  const account = await sender();
  const clients = Array.from({ length: 20 }, () => createDbClient("app", { schema: db.schema }));
  try {
    const answers = await Promise.all(
      clients.map((client, i) => account.send(`key-${i}`, "invite", { client })),
    );
    const outcomes = answers.map((answer) => ("refused" in answer ? answer.refused : "granted"));
    assert.deepEqual(outcomes.sort(), [
      ...Array(5).fill("granted"),
      ...Array(15).fill("invite_cap_reached"),
    ]);
    assert.deepEqual(await counters(account.id), [5, 0]);
  } finally {
    await Promise.all(clients.map((client) => client.$disconnect()));
  }
});

test("one key, ten times at once and then again: one reservation, the same answer each time, one slot", async () => {
  at = THURSDAY;
  const account = await sender();
  const clients = Array.from({ length: 10 }, () => createDbClient("app", { schema: db.schema }));
  try {
    const answers = await Promise.all(
      clients.map((client) => account.send("key-once", "message", { client })),
    );
    const [first] = answers;
    assert.ok(first && "reservationId" in first);
    for (const answer of answers) assert.deepEqual(answer, first);
    assert.deepEqual(await account.send("key-once", "message"), first);
    const [day] = await account.days();
    assert.deepEqual([day?.messagesReserved, await live("key-once")], [1, 1]);
    await account.commit(first.reservationId);
    const committed = { reservationId: first.reservationId, status: "committed" };
    assert.deepEqual(await account.send("key-once", "message"), committed);
  } finally {
    await Promise.all(clients.map((client) => client.$disconnect()));
  }
});

test("a released key reserves again, as a new row; an expired one too; a commit twice counts once", async () => {
  at = THURSDAY;
  const account = await sender();
  const first = granted(await account.send("key-again"));
  await account.release(first);
  await account.release(first);
  const second = granted(await account.send("key-again"));
  assert.notEqual(second, first);
  at = new Date(THURSDAY.getTime() + SEND_RESERVATION_MS);
  const third = granted(await account.send("key-again"));
  assert.notEqual(third, second);
  const statuses = await app.senderQuotaReservation.findMany({
    where: { idempotencyKey: "key-again" },
    orderBy: { createdAt: "asc" },
  });
  assert.deepEqual(
    statuses.map((row) => row.status),
    ["released", "expired", "reserved"],
  );
  assert.deepEqual(await counters(account.id), [1, 0]);

  const answer = { reservationId: third, status: "committed" };
  assert.deepEqual(await account.commit(third), answer);
  assert.deepEqual(await account.commit(third), answer);
  assert.deepEqual(await counters(account.id), [0, 1]);
});

test("a late commit counts: an expired reservation alone is committed; beside an open twin it is committed_late, both count, and the partial unique index holds", async () => {
  at = THURSDAY;
  const account = await sender();
  const lone = granted(await account.send("key-lone"));
  at = new Date(THURSDAY.getTime() + SEND_RESERVATION_MS);
  granted(await account.send("key-sweeper")); // its sweep expires the lone one
  assert.deepEqual(await account.commit(lone), { reservationId: lone, status: "committed" });

  const old = granted(await account.send("key-twin"));
  await account.release(old);
  const twin = granted(await account.send("key-twin"));
  const late = { reservationId: old, status: "committed_late" };
  assert.deepEqual(await account.commit(old), late);
  assert.deepEqual(await account.commit(old), late);
  assert.deepEqual(await account.send("key-twin"), { reservationId: twin, status: "reserved" });
  await account.commit(twin);
  assert.equal(await live("key-twin"), 1);
  // The sweeper's still held; the lone one, the old one and its twin made.
  assert.deepEqual(await counters(account.id), [1, 3]);
  await assert.rejects(account.release(old), { code: "reservation_not_open" });

  const [day] = await account.days();
  const row = {
    id: newId(ids.sender_quota_reservation),
    workspaceId: account.workspaceId,
    senderAccountId: account.id,
    usageId: day?.id ?? "",
    actionType: "invite" as const,
    idempotencyKey: "key-twin",
    count: 1,
    expiresAt: at,
    createdAt: at,
  };
  await assert.rejects(app.senderQuotaReservation.create({ data: row }), {
    code: "P2002",
    message: /sender_quota_reservations_live_key/,
  });
  // The key's CHECK: a read carries none, a send one, for one action.
  const id = () => newId(ids.sender_quota_reservation);
  const read = { ...row, id: id(), actionType: "read" as const, idempotencyKey: "key-read" };
  assert.equal(await sqlstate(app.senderQuotaReservation.create({ data: read })), "23514");
  const two = { ...row, id: id(), idempotencyKey: "key-two", count: 2 };
  assert.equal(await sqlstate(app.senderQuotaReservation.create({ data: two })), "23514");
});
